import { expect, test } from "bun:test"
import { sanitizeSurrogates } from "../src/utils/sanitize.js"

test("retains a fully well-formed object graph", () => {
  const bytes = new Uint8Array([1, 2, 3])
  const error = new Error("valid")
  const shared = { text: "valid", nested: ["also valid"] }
  const array = [shared, bytes, error]
  const input = { array, shared, record: { array, shared } }

  const sanitized = sanitizeSurrogates(input)

  expect(sanitized).toBe(input)
  expect(sanitized.array).toBe(array)
  expect(sanitized.array[0]).toBe(shared)
  expect(sanitized.array[1]).toBe(bytes)
  expect(sanitized.array[2]).toBe(error)
  expect(sanitized.record).toBe(input.record)
  expect(sanitized.record.array).toBe(array)
  expect(sanitized.record.shared).toBe(shared)
})

test("copies only ancestors of a malformed nested string", () => {
  const shared = { text: "unchanged" }
  const nested = { text: "bad \uD800", shared }
  const array = [nested, shared]
  const input = { nested, array, shared }

  const sanitized = sanitizeSurrogates(input)

  expect(sanitized).not.toBe(input)
  expect(sanitized.nested).not.toBe(nested)
  expect(sanitized.nested.text).toBe("bad \uFFFD")
  expect(sanitized.nested.shared).toBe(shared)
  expect(sanitized.array).not.toBe(array)
  expect(sanitized.array[0]).not.toBe(nested)
  expect(sanitized.array[1]).toBe(shared)
  expect(sanitized.shared).toBe(shared)
  expect(nested.text).toBe("bad \uD800")
})

test("sanitizes malformed record keys without copying unchanged values", () => {
  const shared = { text: "unchanged" }
  const input = { "bad\uD800": shared, stable: shared }

  const sanitized = sanitizeSurrogates(input)

  expect(sanitized).not.toBe(input)
  expect(sanitized["bad\uFFFD"]).toBe(shared)
  expect(Object.prototype.hasOwnProperty.call(sanitized, "bad\uD800")).toBe(false)
  expect(sanitized.stable).toBe(shared)
  expect(input["bad\uD800"]).toBe(shared)
})

test("uses the last value when a malformed key collides with its replacement", () => {
  const malformedFirst = { before: true, "key\uD800": "malformed", "key\uFFFD": "replacement", after: true }
  const replacementFirst = { before: true, "key\uFFFD": "replacement", "key\uD800": "malformed", after: true }

  const malformedFirstResult = sanitizeSurrogates(malformedFirst)
  const replacementFirstResult = sanitizeSurrogates(replacementFirst)

  expect(Object.keys(malformedFirstResult)).toEqual(["before", "key\uFFFD", "after"])
  expect(Object.keys(replacementFirstResult)).toEqual(["before", "key\uFFFD", "after"])
  expect(malformedFirstResult["key\uFFFD"]).toBe("replacement")
  expect(replacementFirstResult["key\uFFFD"]).toBe("malformed")
  expect(Object.prototype.hasOwnProperty.call(malformedFirstResult, "key\uD800")).toBe(false)
  expect(Object.prototype.hasOwnProperty.call(replacementFirstResult, "key\uD800")).toBe(false)
})

test("does not sanitize Uint8Array or Error instances", () => {
  const bytes = new Uint8Array([1, 2, 3])
  const error = Object.assign(new Error("bad \uD800"), { detail: "bad \uD800" })
  const input = { bytes, error }

  const sanitized = sanitizeSurrogates(input)

  expect(sanitized).toBe(input)
  expect(sanitized.bytes).toBe(bytes)
  expect(sanitized.error).toBe(error)
  expect(sanitized.error.message).toBe("bad \uD800")
})
