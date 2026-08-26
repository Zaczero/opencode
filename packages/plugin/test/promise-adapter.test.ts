import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { Effect, Schema, Stream } from "effect"
import { OpenCodeEvent } from "@opencode-ai/protocol/groups/event"
import type { Context } from "../src/effect/plugin.js"
import { fromPromise } from "../src/promise/adapter.js"
import { define } from "../src/promise/plugin.js"

afterEach(() => mock.restore())

test("Promise event subscriptions encode once and preserve stream order", async () => {
  const first = SessionEvent.Synthetic.make({
    id: "evt_first",
    created: 1,
    type: "session.synthetic",
    durable: { aggregateID: "ses_1", seq: 1, version: 1 },
    data: { sessionID: "ses_1", text: "first", description: undefined, metadata: undefined },
  })
  const second = SessionEvent.Synthetic.make({
    id: "evt_second",
    created: 2,
    type: "session.synthetic",
    durable: { aggregateID: "ses_1", seq: 2, version: 1 },
    data: { sessionID: "ses_1", text: "second", description: undefined, metadata: undefined },
  })
  const events = [first, second]
  const host = createHost(Stream.fromIterable(events))
  const encoded = spyOn(Schema, "encodeUnknownEffect")
  const received: unknown[] = []

  await Effect.runPromise(
    Effect.scoped(
      fromPromise(
        define({
          id: "promise-event-encoding",
          setup: async (context) => {
            for await (const event of context.event.subscribe()) received.push(event)
          },
        }),
      ).effect(host),
    ),
  )

  expect(received).toEqual([
    {
      id: "evt_first",
      created: 1,
      type: "session.synthetic",
      durable: { aggregateID: "ses_1", seq: 1, version: 1 },
      data: { sessionID: "ses_1", text: "first" },
    },
    {
      id: "evt_second",
      created: 2,
      type: "session.synthetic",
      durable: { aggregateID: "ses_1", seq: 2, version: 1 },
      data: { sessionID: "ses_1", text: "second" },
    },
  ])
  expect(encoded.mock.calls.filter(([schema]) => schema === OpenCodeEvent)).toHaveLength(1)
})

function createHost(events: ReturnType<Context["event"]["subscribe"]>) {
  const unused = (..._args: never[]) => Effect.die("unused")
  return {
    app: { name: "test", version: "test", channel: "test" },
    options: {},
    agent: { get: unused, list: unused, transform: unused, reload: unused },
    aisdk: { hook: unused },
    catalog: {
      provider: { list: unused, get: unused },
      model: { list: unused, default: unused },
      transform: unused,
      reload: unused,
    },
    command: { list: unused, transform: unused, reload: unused },
    event: { subscribe: () => events },
    generate: { text: unused },
    integration: {
      list: unused,
      get: unused,
      connect: { key: unused },
      oauth: { connect: unused, status: unused, complete: unused, cancel: unused },
      command: { connect: unused, status: unused, cancel: unused },
      transform: unused,
      reload: unused,
      connection: { active: unused, resolve: unused },
    },
    mcp: {
      list: unused,
      add: unused,
      remove: unused,
      connect: unused,
      disconnect: unused,
      transform: unused,
      reload: unused,
    },
    permission: { hook: unused, list: unused, get: unused, reply: unused },
    plugin: { list: unused },
    reference: { list: unused, transform: unused, reload: unused },
    skill: { list: unused, transform: unused, reload: unused },
    storage: { get: unused, set: unused, remove: unused, scan: unused },
    session: {
      hook: unused,
      create: unused,
      get: unused,
      switchAgent: unused,
      switchModel: unused,
      prompt: unused,
      generate: unused,
      command: unused,
      synthetic: unused,
      interrupt: unused,
      rename: unused,
      wait: unused,
      context: unused,
    },
    shell: { hook: unused },
    tool: { transform: unused, hook: unused },
    vcs: { get: unused, branches: unused, status: unused, diff: unused, transform: unused, reload: unused },
    websearch: { providers: unused, query: unused, transform: unused, reload: unused },
  } satisfies Context
}
