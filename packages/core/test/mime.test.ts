import { describe, expect, test } from "bun:test"
import { detect } from "../src/mime"

const signatures: Array<{ name: string; bytes: number[]; mime: ReturnType<typeof detect> }> = [
  { name: "PNG", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: "image/png" },
  { name: "JPEG", bytes: [0xff, 0xd8, 0xff], mime: "image/jpeg" },
  { name: "GIF", bytes: [0x47, 0x49, 0x46, 0x38], mime: "image/gif" },
  { name: "BMP", bytes: [0x42, 0x4d], mime: "image/bmp" },
  { name: "PDF", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], mime: "application/pdf" },
  { name: "WebP", bytes: [0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03, 0x04, 0x57, 0x45, 0x42, 0x50], mime: "image/webp" },
  { name: "AVIF", bytes: [0x01, 0x02, 0x03, 0x04, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66], mime: "image/avif" },
  { name: "AVIS", bytes: [0x01, 0x02, 0x03, 0x04, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x73], mime: "image/avif" },
]

describe("Mime.detect", () => {
  test.each(signatures)("recognizes $name", ({ bytes, mime }) => {
    expect(detect(Uint8Array.from(bytes))).toBe(mime)
  })

  test.each(signatures)("does not recognize truncated $name", ({ name, bytes }) => {
    const expected = name === "GIF" || name === "BMP" || name === "PDF" ? "text/plain" : "application/octet-stream"
    expect(detect(Uint8Array.from(bytes.slice(0, -1)))).toBe(expected)
  })

  test.each(signatures)("keeps $name classification when payload contains controls and NUL", ({ bytes, mime }) => {
    expect(detect(Uint8Array.from([...bytes, 0, 1, 2, 10, 31, 255]))).toBe(mime)
  })

  test("classifies empty input as text", () => {
    expect(detect(new Uint8Array())).toBe("text/plain")
  })

  test("classifies ASCII input as text", () => {
    expect(detect(new TextEncoder().encode("plain ASCII text"))).toBe("text/plain")
  })

  test("classifies valid multibyte UTF-8 as text", () => {
    expect(detect(new TextEncoder().encode("valid UTF-8: 世界"))).toBe("text/plain")
  })

  test("preserves an incomplete UTF-8 sequence at the sample boundary", () => {
    const bytes = new Uint8Array(256 * 1024 + 1).fill(97)
    bytes[256 * 1024 - 1] = 0xc3
    bytes[256 * 1024] = 0xa4
    expect(detect(bytes)).toBe("text/plain")
  })

  test("rejects malformed UTF-8", () => {
    expect(detect(new Uint8Array([0xc3, 0x28]))).toBe("application/octet-stream")
  })

  test("accepts incomplete trailing UTF-8", () => {
    expect(detect(new Uint8Array([0xc3]))).toBe("text/plain")
  })

  test("does not retain UTF-8 decoder state between calls", () => {
    expect(detect(new Uint8Array([0xc3]))).toBe("text/plain")
    expect(detect(new TextEncoder().encode("plain text"))).toBe("text/plain")
    expect(detect(new Uint8Array([0xc3, 0x28]))).toBe("application/octet-stream")
    expect(detect(new TextEncoder().encode("plain text"))).toBe("text/plain")
  })

  test("rejects an embedded NUL below the control threshold", () => {
    expect(detect(Uint8Array.from([...new TextEncoder().encode("123456789"), 0]))).toBe("application/octet-stream")
  })

  test("accepts exactly 30 percent classified controls", () => {
    expect(detect(new Uint8Array([1, 2, 3, 97, 98, 99, 100, 101, 102, 103]))).toBe("text/plain")
  })

  test("uses a fractional control threshold", () => {
    expect(detect(new Uint8Array([1, 2, 97, 98, 99, 100, 101]))).toBe("text/plain")
    expect(detect(new Uint8Array([1, 2, 3, 97, 98, 99, 100]))).toBe("application/octet-stream")
  })

  test("rejects more than 30 percent classified controls", () => {
    expect(detect(new Uint8Array([1, 2, 3, 4, 97, 98, 99, 100, 101, 102]))).toBe("application/octet-stream")
  })

  test("does not count permitted whitespace controls", () => {
    expect(detect(new Uint8Array([9, 10, 11, 12, 13]))).toBe("text/plain")
  })
})
