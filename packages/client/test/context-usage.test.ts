import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "../src/promise"
import { contextUsage, lastAssistantWithUsage } from "../src/context-usage"

const assistant = (id: string, input: number): SessionMessageInfo => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  content: [],
  tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0 },
})

test("tracks usage across undo and redo boundaries", () => {
  const messages = [assistant("msg_z", 10), assistant("msg_a", 30)]

  expect(lastAssistantWithUsage(messages)?.tokens.input).toBe(30)
  expect(lastAssistantWithUsage(messages, "msg_a")?.tokens.input).toBe(10)
  expect(lastAssistantWithUsage(messages, "msg_missing")).toBeUndefined()
  expect(lastAssistantWithUsage(messages)?.tokens.input).toBe(30)
})

test("resets usage at completed compaction until the next assistant reports it", () => {
  const compaction: SessionMessageInfo = {
    id: "msg_compaction",
    type: "compaction",
    status: "completed",
    reason: "manual",
    summary: "Current state",
    recent: "",
    time: { created: 0 },
  }
  const messages = [assistant("msg_before", 30), compaction]

  expect(lastAssistantWithUsage(messages)).toBeUndefined()
  expect(lastAssistantWithUsage(messages, "msg_compaction")?.tokens.input).toBe(30)

  messages.push(assistant("msg_after", 5))
  expect(lastAssistantWithUsage(messages)?.tokens.input).toBe(5)
})

test("failed compaction retains the last measured usage", () => {
  expect(
    lastAssistantWithUsage([
      assistant("msg_before", 30),
      {
        id: "msg_compaction",
        type: "compaction",
        status: "failed",
        reason: "auto",
        error: { type: "compaction.failed", message: "No summary" },
        time: { created: 0 },
      },
    ])?.tokens.input,
  ).toBe(30)
})

test("context usage counts input, output, reasoning, and both cache categories", () => {
  expect(
    contextUsage(
      { input: 27, output: 4, reasoning: 2, cache: { read: 3, write: 7 } },
      { context: 100, compaction: 80 },
    ),
  ).toEqual({ tokens: 43, percent: 54 })
})

test.each([
  { name: "empty usage", tokens: 0, limit: { context: 1_000, compaction: 800 }, percent: 0 },
  { name: "nonzero usage", tokens: 1, limit: { context: 1_000, compaction: 800 }, percent: 1 },
  { name: "fractional usage rounds up", tokens: 401, limit: { context: 1_000, compaction: 800 }, percent: 51 },
  { name: "final fractional percent rounds up", tokens: 799, limit: { context: 1_000, compaction: 800 }, percent: 100 },
  { name: "compaction threshold", tokens: 800, limit: { context: 1_000, compaction: 800 }, percent: 100 },
  { name: "compaction overshoot", tokens: 801, limit: { context: 1_000, compaction: 800 }, percent: 100 },
  { name: "full context overshoot", tokens: 1_200, limit: { context: 1_000, compaction: 800 }, percent: 100 },
  { name: "exhausted prompt budget", tokens: 1, limit: { context: 1_000, compaction: 0 }, percent: 100 },
  { name: "raw context fallback", tokens: 401, limit: { context: 1_000 }, percent: 41 },
  { name: "exact percentage stays exact", tokens: 29, limit: { context: 100 }, percent: 29 },
  { name: "unknown context", tokens: 100, limit: { context: 0 }, percent: undefined },
  { name: "missing model", tokens: 100, limit: undefined, percent: undefined },
])("$name", ({ tokens, limit, percent }) => {
  expect(contextUsage({ input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, limit)).toEqual({
    tokens,
    percent,
  })
})
