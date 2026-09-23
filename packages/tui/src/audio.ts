import { Audio, type AudioErrorContext, type AudioPlayOptions, type AudioSound } from "@opentui/core"
import { readFile } from "node:fs/promises"

let audio: Audio | null | undefined
const sounds = new Map<string, Promise<AudioSound | null>>()

function getAudio() {
  if (audio !== undefined) return audio
  try {
    const next = Audio.create({ autoStart: false })
    next.on("error", (error: Error, context: AudioErrorContext) => {
      console.debug("tui audio error", { error, context })
    })
    audio = next
    return next
  } catch (error) {
    console.debug("failed to create tui audio", { error })
    audio = null
    return null
  }
}

export function loadSoundFile(file: string) {
  const current = getAudio()
  if (!current) return Promise.resolve(null)
  const cached = sounds.get(file)
  if (cached) return cached
  const task = readFile(file)
    .then((bytes) => current.loadSound(bytes))
    .catch((error) => {
      console.debug("failed to load tui sound", { file, error })
      return null
    })
  sounds.set(file, task)
  return task
}

export function play(sound: AudioSound, options?: AudioPlayOptions) {
  const current = getAudio()
  if (!current) return null
  if (!current.isStarted() && !current.start()) return null
  return current.play(sound, options)
}

export type Recording = {
  readonly sampleRate: number
  /** Ends capture and returns the mono samples recorded so far. */
  readonly stop: () => Promise<Float32Array>
  readonly cancel: () => void
}

/** Starts capturing mono audio from the system's default input device. */
export async function record(): Promise<Recording | null> {
  const current = getAudio()
  if (!current) return null
  const stream = await current.openCapture({ channels: 1 })
  const reader = stream.readable.getReader()
  const chunks: Float32Array[] = []
  const pump = (async () => {
    for (;;) {
      const next = await reader.read()
      if (next.done) return
      chunks.push(next.value)
    }
  })().catch(() => undefined)
  const finish = async () => {
    stream.stop()
    await reader.cancel().catch(() => undefined)
    await pump
    stream.dispose()
  }
  return {
    sampleRate: stream.sampleRate,
    stop: async () => {
      await finish()
      const samples = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
      chunks.reduce((offset, chunk) => (samples.set(chunk, offset), offset + chunk.length), 0)
      return samples
    },
    cancel: () => void finish(),
  }
}

export function dispose() {
  audio?.dispose()
  audio = undefined
  sounds.clear()
}
