import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { Config } from "@opencode-ai/schema/config"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { OpenCodeEvent } from "@opencode-ai/protocol/groups/event"
import { Effect, Schema, SchemaAST, Stream } from "effect"
import type { Context } from "../src/effect/plugin.js"
import { fromPromise } from "../src/promise/adapter.js"
import { define } from "../src/promise/plugin.js"

afterEach(() => mock.restore())

test("Promise event subscriptions filter before encoding and preserve stream order", async () => {
  const events = makeEvents()
  const host = createHost(Stream.fromIterable(events))
  const originalEncode = Schema.encodeUnknownEffect
  let eventEncodes = 0
  const encoded = spyOn(Schema, "encodeUnknownEffect").mockImplementation(
    <S extends Schema.Constraint>(schema: S, options?: SchemaAST.ParseOptions) => {
      const encode = originalEncode(schema, options)
      return (input: unknown, parseOptions?: SchemaAST.ParseOptions) => {
        if (Object.is(schema, OpenCodeEvent)) eventEncodes++
        return encode(input, parseOptions)
      }
    },
  )
  const received: unknown[] = []

  await Effect.runPromise(
    Effect.scoped(
      fromPromise(
        define({
          id: "promise-event-encoding",
          setup: async (context) => {
            for await (const event of context.event.subscribe(["session.synthetic"])) received.push(event)
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
      created: 3,
      type: "session.synthetic",
      durable: { aggregateID: "ses_1", seq: 2, version: 1 },
      data: { sessionID: "ses_1", text: "second" },
    },
  ])
  expect(eventEncodes).toBe(2)
  expect(encoded.mock.calls.filter(([schema]) => schema === OpenCodeEvent)).toHaveLength(1)
})

test("Promise event subscriptions receive all events by default", async () => {
  const events = makeEvents()
  const host = createHost(Stream.fromIterable(events.slice(0, 2)))
  const received: unknown[] = []

  await Effect.runPromise(
    Effect.scoped(
      fromPromise(
        define({
          id: "promise-event-unfiltered",
          setup: async (context) => {
            for await (const event of context.event.subscribe()) received.push(event)
          },
        }),
      ).effect(host),
    ),
  )

  expect(received.map((event) => (event as { readonly type: string }).type)).toEqual([
    "session.synthetic",
    "config.updated",
  ])
})

test("Promise event subscriptions retain generated request options", async () => {
  const host = createHost(Stream.fromIterable(makeEvents().slice(0, 1)))
  const received: unknown[] = []

  await Effect.runPromise(
    Effect.scoped(
      fromPromise(
        define({
          id: "promise-event-request-options",
          setup: async (context) => {
            for await (const event of context.event.subscribe({ signal: new AbortController().signal })) {
              received.push(event)
            }
          },
        }),
      ).effect(host),
    ),
  )

  expect(received.map((event) => (event as { readonly type: string }).type)).toEqual(["session.synthetic"])
})

test("Promise plugins can snapshot executing sessions", async () => {
  const executing = [{ sessionID: "ses_running", startedAt: 123 }]
  const host = createHost(Stream.empty, Effect.succeed(executing))
  const received: unknown[] = []

  await Effect.runPromise(
    Effect.scoped(
      fromPromise(
        define({
          id: "promise-executing-sessions",
          setup: async (context) => void received.push(await context.session.executing()),
        }),
      ).effect(host),
    ),
  )

  expect(received).toEqual([executing])
})

function makeEvents() {
  return [
    SessionEvent.Synthetic.make({
      id: "evt_first",
      created: 1,
      type: "session.synthetic",
      durable: { aggregateID: "ses_1", seq: 1, version: 1 },
      data: { sessionID: "ses_1", text: "first", description: undefined, metadata: undefined },
    }),
    Config.Event.Updated.make({
      id: "evt_foreign",
      created: 2,
      type: "config.updated",
      data: {},
    }),
    SessionEvent.Synthetic.make({
      id: "evt_second",
      created: 3,
      type: "session.synthetic",
      durable: { aggregateID: "ses_1", seq: 2, version: 1 },
      data: { sessionID: "ses_1", text: "second", description: undefined, metadata: undefined },
    }),
  ] as const
}

function createHost(
  events: ReturnType<Context["event"]["subscribe"]>,
  executing: Context["session"]["executing"] = Effect.die("unused session.executing"),
) {
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
    event: {
      subscribe: (types) => {
        if (!types?.length) return events
        const selected = new Set(types)
        return events.pipe(Stream.filter((event) => selected.has(event.type)))
      },
    },
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
      executing,
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
