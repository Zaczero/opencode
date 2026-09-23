import { describe, expect, test } from "bun:test"
import { createHoldGesture, encodeWav } from "../../src/feature-plugins/prompt/dictation"

type Key = Parameters<ReturnType<typeof createHoldGesture>["key"]>[0]

function harness(enabled = true) {
  const log: string[] = []
  const timers = new Map<number, { callback: () => void; ms: number }>()
  let next = 0
  const gesture = createHoldGesture({
    enabled: () => enabled,
    pressed: () => log.push("pressed"),
    start: () => log.push("start"),
    stop: () => log.push("stop"),
    cancel: () => log.push("cancel"),
    setTimer: (callback, ms) => {
      timers.set(++next, { callback, ms })
      return next
    },
    clearTimer: (timer) => timers.delete(timer as number),
  })
  const key = (name: string, eventType: Key["eventType"] = "press") =>
    gesture.key({ name, eventType, ctrl: false, meta: false, shift: false, option: false, super: false })
  const fire = () => {
    const [id, timer] = [...timers].at(-1)!
    timers.delete(id)
    timer.callback()
    return timer.ms
  }
  return { log, timers, key, fire }
}

describe("dictation hold gesture", () => {
  test("a tap types its space and discards its capture", () => {
    const h = harness()
    expect(h.key("space")).toBe(false)
    expect(h.key("space", "release")).toBe(false)
    expect(h.timers.size).toBe(0)
    expect(h.log).toEqual(["pressed", "cancel"])
  })

  test("holding past the delay records until release and swallows repeats", () => {
    const h = harness()
    expect(h.key("space")).toBe(false)
    expect(h.fire()).toBe(500)
    expect(h.key("space", "repeat")).toBe(true)
    h.key("space", "release")
    expect(h.log).toEqual(["pressed", "start", "stop"])
  })

  test("releasing another key neither abandons a hold nor ends a recording", () => {
    const h = harness()
    h.key("space")
    h.key("a", "release")
    h.fire()
    h.key("a", "release")
    h.key("space", "release")
    expect(h.log).toEqual(["pressed", "start", "stop"])
  })

  test("typing abandons a pending hold, and escape discards a recording", () => {
    const h = harness()
    h.key("space")
    expect(h.key("a")).toBe(false)
    expect(h.timers.size).toBe(0)
    h.key("space")
    h.fire()
    expect(h.key("escape")).toBe(true)
    expect(h.log).toEqual(["pressed", "cancel", "pressed", "start", "cancel"])
  })

  test("does nothing while disabled", () => {
    const h = harness(false)
    expect(h.key("space")).toBe(false)
    expect(h.timers.size).toBe(0)
    expect(h.log).toEqual([])
  })
})

describe("dictation audio", () => {
  test("encodes normalized 24 kHz mono 16-bit WAV", () => {
    const samples = Float32Array.from({ length: 48_000 }, (_, index) => (index % 2 ? 0.1 : -0.1))
    const wav = encodeWav(samples, 48_000)
    const view = new DataView(wav.buffer)
    const text = (offset: number) => new TextDecoder().decode(wav.slice(offset, offset + 4))
    expect([text(0), text(8), text(12), text(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"])
    expect([view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true)]).toEqual([1, 24_000, 16])
    expect(view.getUint32(40, true)).toBe(24_000 * 2)
    const peak = Array.from({ length: 24_000 }, (_, index) => Math.abs(view.getInt16(44 + index * 2, true))).reduce(
      (max, value) => Math.max(max, value),
      0,
    )
    expect(peak).toBe(Math.floor(0.9 * 0x7fff))
  })
})
