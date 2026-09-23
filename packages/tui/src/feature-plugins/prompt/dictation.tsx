import { Plugin } from "@opencode/plugin/tui"
import { Transcription } from "@opencode/schema/transcription"
import type { KeyEvent } from "@opentui/core"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import { record, type Recording } from "../../audio"
import { Spinner } from "../../component/spinner"
import { usePromptRef } from "../../context/prompt"
import { useTheme } from "../../context/theme"
import { useToast } from "../../ui/toast"

// Holding space dictates into the prompt, as the Codex CLI did. A tap still types a space: the space is
// inserted at once and removed only when the hold turns into a recording. Capture starts on the press, so
// speech during the hold delay is kept; a tap discards it. Once a hold shows as listening, its release
// always transcribes. The gesture needs key-release reports, so it is enabled only under the kitty
// keyboard protocol.
const HOLD_MS = 500
const SAMPLE_RATE = 24_000

export type HoldEvents = {
  readonly enabled: () => boolean
  /** A fresh press, before the prompt inserts its space. */
  readonly pressed: () => void
  /** The press became a hold. */
  readonly start: () => void
  readonly stop: () => void
  /** Discards the capture begun by `pressed`, after a tap or on escape. */
  readonly cancel: () => void
  readonly setTimer: (callback: () => void, ms: number) => unknown
  readonly clearTimer: (timer: unknown) => void
}

type HoldKey = Pick<KeyEvent, "name" | "eventType" | "ctrl" | "meta" | "shift" | "option" | "super">

/** Space-hold gesture. `key` returns true when the event must not reach the prompt. */
export function createHoldGesture(events: HoldEvents) {
  let state: "idle" | "pending" | "recording" = "idle"
  let timer: unknown

  const end = (event: () => void) => {
    if (timer !== undefined) events.clearTimer(timer)
    timer = undefined
    state = "idle"
    event()
  }
  const held = () => {
    timer = undefined
    state = "recording"
    events.start()
  }

  return {
    key(event: HoldKey) {
      const space =
        event.name === "space" && !event.ctrl && !event.meta && !event.shift && !event.option && !event.super
      if (state === "idle") {
        if (!space || event.eventType !== "press" || !events.enabled()) return false
        events.pressed()
        state = "pending"
        timer = events.setTimer(held, HOLD_MS)
        return false
      }
      // Releases of other keys are typing rollover, not a decision about the hold.
      if (!space && event.eventType === "release") return false
      if (space && event.eventType !== "release") return true
      if (state === "recording" && event.name === "escape") {
        end(events.cancel)
        return true
      }
      end(state === "pending" ? events.cancel : events.stop)
      return false
    },
  }
}

/** Peak-normalized, 24 kHz mono 16-bit PCM WAV, the shape ChatGPT dictation expects. */
export function encodeWav(samples: Float32Array, sampleRate: number) {
  const length = Math.floor((samples.length * SAMPLE_RATE) / sampleRate)
  const resampled = Float32Array.from({ length }, (_, index) => {
    const position = (index * sampleRate) / SAMPLE_RATE
    const low = Math.floor(position)
    const high = Math.min(low + 1, samples.length - 1)
    return samples[low]! + (samples[high]! - samples[low]!) * (position - low)
  })
  const peak = resampled.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0)
  const gain = peak > 0 ? 0.9 / peak : 1
  const buffer = new ArrayBuffer(44 + length * 2)
  const view = new DataView(buffer)
  const ascii = (offset: number, text: string) =>
    [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
  ascii(0, "RIFF")
  view.setUint32(4, 36 + length * 2, true)
  ascii(8, "WAVE")
  ascii(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, "data")
  view.setUint32(40, length * 2, true)
  resampled.forEach((sample, index) =>
    view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, sample * gain)) * 0x7fff, true),
  )
  return new Uint8Array(buffer)
}

export default Plugin.define({
  id: "opencode.dictation",
  setup(context) {
    const [phase, setPhase] = createSignal<"idle" | "recording" | "transcribing">("idle")

    context.ui.slot({
      append: "prompt.footer.status",
      render: () => {
        const theme = useTheme()
        return (
          <Show when={phase() !== "idle"}>
            <box flexShrink={0}>
              <Spinner color={theme.hue.interactive[200]}>
                {phase() === "recording" ? "Listening" : "Transcribing"}
              </Spinner>
            </box>
          </Show>
        )
      },
    })

    context.ui.slot({
      append: "app",
      render() {
        const renderer = useRenderer()
        const prompt = usePromptRef()
        const toast = useToast()
        let available = true
        let before: { text: string; cursor: number } | undefined
        let recording: Promise<Recording | null> | undefined

        const fail = (message: string) => {
          setPhase("idle")
          toast.show({ variant: "error", message })
        }
        const transcribe = async (take: Promise<Recording | null>) => {
          const active = await take.catch(() => null)
          if (!active) return fail("No microphone is available for dictation.")
          const samples = await active.stop()
          if (samples.length === 0) return fail("The microphone captured no audio.")
          setPhase("transcribing")
          const audio = Buffer.from(encodeWav(samples, active.sampleRate)).toString("base64")
          const result = await context.client
            .rpc(Transcription.Definition)
            .transcribe({ audio })
            .then(
              (output) => ({ text: output.text }),
              (error: unknown) => ({ error }),
            )
          setPhase("idle")
          if ("error" in result) {
            const reason = result.error as { type?: string; message?: string }
            // Without an OpenAI account every hold would fail the same way; stop listening for it.
            if (reason.type === "unavailable") available = false
            return fail(reason.message ?? "Dictation failed.")
          }
          if (result.text) prompt.current?.insert(result.text)
        }

        const gesture = createHoldGesture({
          enabled: () =>
            available &&
            phase() === "idle" &&
            prompt.current?.focused === true &&
            renderer.capabilities?.kitty_keyboard === true,
          pressed: () => {
            const current = prompt.current
            before = current ? { text: current.current.text, cursor: current.cursor } : undefined
            recording = record()
          },
          start: () => {
            const current = prompt.current
            // Remove the space the press typed, unless something else changed the prompt meanwhile.
            if (
              current &&
              before &&
              current.current.text.length === before.text.length + 1 &&
              current.cursor === before.cursor + 1
            )
              current.deleteBackward()
            setPhase("recording")
          },
          stop: () => {
            const take = recording
            recording = undefined
            if (take) void transcribe(take)
          },
          cancel: () => {
            const take = recording
            recording = undefined
            setPhase("idle")
            void take?.then((active) => active?.cancel()).catch(() => undefined)
          },
          setTimer: (callback, ms) => setTimeout(callback, ms),
          clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
        })

        useKeyboard(
          (event) => {
            if (gesture.key(event)) event.preventDefault()
          },
          { release: true },
        )
        return null
      },
    })
  },
})
