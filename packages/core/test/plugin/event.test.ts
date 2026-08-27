import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Schema, Stream } from "effect"
import { define } from "@opencode/plugin/effect/plugin"
import type { Plugin as PluginDefinition } from "@opencode/plugin/effect/plugin"
import { Config as ConfigSchema } from "@opencode/schema/config"
import { Event } from "@opencode/schema/event"
import { McpEvent } from "@opencode/schema/mcp-event"
import { AbsolutePath } from "@opencode/schema/schema"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Location } from "@opencode/core/location"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"
const it = testEffect(PluginTestLayer)
const generation = (plugin: PluginDefinition, revision = "1") => ({ ...plugin, revision })
it.effect("selects public RPC events alongside manifest events", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const bus = yield* Bus.Service
    const host = yield* PluginHost.make(plugins)
    const rpc = Bus.ephemeral({ type: "rpc.review.updated", schema: { text: Schema.String } })
    const received = yield* host.event
      .subscribe([rpc.type, "config.updated"])
      .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
    yield* Effect.yieldNow
    yield* bus.publish(Agent.Event.Updated, {})
    yield* bus.publish(rpc, { text: "review complete" })
    yield* bus.publish(ConfigSchema.Event.Updated, {})
    expect((yield* Fiber.join(received)).map((event) => event.type)).toEqual(["rpc.review.updated", "config.updated"])
  }),
)
it.effect("exposes public events through the plugin context", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const bus = yield* Bus.Service
    const host = yield* PluginHost.make(plugins)
    const received = yield* host.event
      .subscribe()
      .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
    yield* Effect.yieldNow

    yield* bus.publish(ConfigSchema.Event.Updated, {})
    yield* bus.publish(Agent.Event.Updated, {})

    expect(Array.from(yield* Fiber.join(received), (event) => event.type)).toEqual(["config.updated", "agent.updated"])
  }),
)

it.effect("filters public events by selected type", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const bus = yield* Bus.Service
    const host = yield* PluginHost.make(plugins)
    const received = yield* host.event
      .subscribe(["config.updated"])
      .pipe(Stream.take(1), Stream.runHead, Effect.forkScoped({ startImmediately: true }))
    yield* Effect.yieldNow

    yield* bus.publish(Agent.Event.Updated, {})
    yield* bus.publish(ConfigSchema.Event.Updated, {})

    expect((yield* Fiber.join(received)).valueOrUndefined?.type).toBe("config.updated")
  }),
)

it.effect("does not expose internal events through selected plugin streams", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const bus = yield* Bus.Service
    const host = yield* PluginHost.make(plugins)
    const completed = yield* Deferred.make<void>()
    const received: string[] = []
    const internal = yield* host.event.subscribe([McpEvent.ToolsChanged.type]).pipe(
      Stream.runForEach((event) => Effect.sync(() => received.push(event.type))),
      Effect.onExit(() => Deferred.succeed(completed, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* Effect.yieldNow

    yield* bus.publish(McpEvent.ToolsChanged, { server: "test" })
    yield* Effect.yieldNow

    expect(received).toEqual([])
    expect(yield* Deferred.isDone(completed)).toBe(false)
    yield* Fiber.interrupt(internal)
    expect(yield* Deferred.isDone(completed)).toBe(true)
  }),
)

it.effect("routes one selected public event through the typed Bus delivery", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const bus = yield* Bus.Service
    const deliveries = { typed: 0, wildcard: 0 }
    const observedBus = {
      ...bus,
      subscribe: ((input?: Event.Definition | readonly [Event.Definition, ...Event.Definition[]]) => {
        const typed = input !== undefined && !Array.isArray(input)
        const source =
          input === undefined
            ? bus.subscribe()
            : Array.isArray(input)
              ? bus.subscribe(input as readonly [Event.Definition, ...Event.Definition[]])
              : bus.subscribe(input as Event.Definition)
        return source.pipe(
          Stream.tap(() =>
            Effect.sync(() => {
              deliveries[typed ? "typed" : "wildcard"]++
            }),
          ),
        )
      }) as Bus.Interface["subscribe"],
    }
    const host = yield* PluginHost.make(plugins).pipe(Effect.provideService(Bus.Service, observedBus))
    const received = yield* host.event
      .subscribe(["config.updated"])
      .pipe(Stream.take(1), Stream.runHead, Effect.forkScoped({ startImmediately: true }))
    yield* Effect.yieldNow

    yield* bus.publish(Agent.Event.Updated, {})
    yield* bus.publish(
      ConfigSchema.Event.Updated,
      {},
      {
        location: Location.Ref.make({ directory: AbsolutePath.make("/other") }),
      },
    )
    yield* bus.publish(ConfigSchema.Event.Updated, {}, { global: true })

    expect((yield* Fiber.join(received)).valueOrUndefined?.type).toBe("config.updated")
    expect(deliveries).toEqual({ typed: 1, wildcard: 0 })
  }),
)

it.effect("preserves public event selection, order, and location filtering", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const bus = yield* Bus.Service
    const host = yield* PluginHost.make(plugins)
    const collect = (types: readonly string[] | undefined, count: number) =>
      (types === undefined ? host.event.subscribe() : host.event.subscribe(types)).pipe(
        Stream.take(count),
        Stream.map((event) => event.type),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      )

    const omitted = yield* collect(undefined, 2)
    const empty = yield* collect([], 2)
    yield* Effect.yieldNow
    yield* bus.publish(ConfigSchema.Event.Updated, {})
    yield* bus.publish(Agent.Event.Updated, {})
    expect(Array.from(yield* Fiber.join(omitted))).toEqual(["config.updated", "agent.updated"])
    expect(Array.from(yield* Fiber.join(empty))).toEqual(["config.updated", "agent.updated"])

    const one = yield* collect(["config.updated"], 2)
    yield* Effect.yieldNow
    yield* bus.publish(Agent.Event.Updated, {})
    yield* bus.publish(ConfigSchema.Event.Updated, {})
    yield* bus.publish(ConfigSchema.Event.Updated, {})
    expect(Array.from(yield* Fiber.join(one))).toEqual(["config.updated", "config.updated"])

    const completed = yield* Deferred.make<void>()
    const received: string[] = []
    const unknown = yield* host.event.subscribe(["not-a-server-event"]).pipe(
      Stream.runForEach((event) => Effect.sync(() => received.push(event.type))),
      Effect.onExit(() => Deferred.succeed(completed, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* Effect.yieldNow
    expect(yield* Deferred.isDone(completed)).toBe(false)
    yield* bus.publish(Agent.Event.Updated, {})
    yield* bus.publish(McpEvent.ToolsChanged, { server: "test" })
    yield* Effect.yieldNow
    expect(received).toEqual([])
    expect(yield* Deferred.isDone(completed)).toBe(false)
    yield* Fiber.interrupt(unknown)
    expect(yield* Deferred.isDone(completed)).toBe(true)

    const mixed = yield* collect(["config.updated", McpEvent.ToolsChanged.type, "not-a-server-event"], 2)
    yield* Effect.yieldNow
    yield* bus.publish(ConfigSchema.Event.Updated, {})
    yield* bus.publish(McpEvent.ToolsChanged, { server: "test" })
    yield* bus.publish(ConfigSchema.Event.Updated, {})
    expect(Array.from(yield* Fiber.join(mixed))).toEqual(["config.updated", "config.updated"])

    const multiple = yield* collect(["agent.updated", "config.updated"], 3)
    yield* Effect.yieldNow
    yield* bus.publish(ConfigSchema.Event.Updated, {})
    yield* bus.publish(Agent.Event.Updated, {})
    yield* bus.publish(ConfigSchema.Event.Updated, {})
    expect(Array.from(yield* Fiber.join(multiple))).toEqual(["config.updated", "agent.updated", "config.updated"])

    const localAndGlobal = yield* collect(undefined, 2)
    yield* Effect.yieldNow
    yield* bus.publish(ConfigSchema.Event.Updated, {})
    yield* bus.publish(
      ConfigSchema.Event.Updated,
      {},
      {
        location: Location.Ref.make({ directory: AbsolutePath.make("/other") }),
      },
    )
    yield* bus.publish(Agent.Event.Updated, {}, { global: true })
    expect(Array.from(yield* Fiber.join(localAndGlobal))).toEqual(["config.updated", "agent.updated"])
  }),
)

it.effect("unsubscribes plugin event streams when reloading plugins", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const bus = yield* Bus.Service
    const received: string[] = []
    const firstSeen = yield* Deferred.make<void>()
    const secondSeen = yield* Deferred.make<void>()
    const plugin = (version: string, seen: Deferred.Deferred<void>) =>
      define({
        id: "event-listener",
        effect: (ctx) =>
          ctx.event.subscribe(["config.updated"]).pipe(
            Stream.runForEach(() =>
              Effect.sync(() => received.push(version)).pipe(Effect.andThen(Deferred.succeed(seen, undefined))),
            ),
            Effect.forkScoped({ startImmediately: true }),
            Effect.asVoid,
          ),
      })

    yield* plugins.activate([generation(plugin("first", firstSeen), "1")])
    yield* Effect.yieldNow
    yield* bus.publish(ConfigSchema.Event.Updated, {})
    yield* Deferred.await(firstSeen)

    yield* plugins.activate([generation(plugin("second", secondSeen), "2")])
    yield* Effect.yieldNow
    yield* bus.publish(ConfigSchema.Event.Updated, {})
    yield* Deferred.await(secondSeen)
    expect(received).toEqual(["first", "second"])

    yield* plugins.activate([])
    yield* bus.publish(ConfigSchema.Event.Updated, {})
    yield* Effect.yieldNow
    expect(received).toEqual(["first", "second"])
  }),
)

it.effect("preserves ordered selected plugin events across asynchronous consumer delays", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const bus = yield* Bus.Service
    const host = yield* PluginHost.make(plugins)
    const received = new Array<string>()
    const firstReceived = yield* Deferred.make<void>()
    const releaseFirst = yield* Deferred.make<void>()
    const fiber = yield* host.event.subscribe(["config.updated", "agent.updated", "not-a-server-event"]).pipe(
      Stream.take(3),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          received.push(event.type)
          if (received.length !== 1) return
          yield* Deferred.succeed(firstReceived, undefined)
          yield* Deferred.await(releaseFirst)
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* Effect.yieldNow

    yield* bus.publish(ConfigSchema.Event.Updated, {})
    yield* Deferred.await(firstReceived)
    yield* bus.publish(Agent.Event.Updated, {})
    yield* bus.publish(
      ConfigSchema.Event.Updated,
      {},
      { location: Location.Ref.make({ directory: AbsolutePath.make("/other") }) },
    )
    yield* bus.publish(Agent.Event.Updated, {}, { global: true })

    expect(received).toEqual(["config.updated"])
    yield* Deferred.succeed(releaseFirst, undefined)
    yield* Fiber.join(fiber)
    expect(received).toEqual(["config.updated", "agent.updated", "agent.updated"])
  }),
)

it.effect("removes selected plugin subscriptions during reload teardown", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const bus = yield* Bus.Service
    const received = new Array<string>()
    const firstSeen = yield* Deferred.make<void>()
    const secondSeen = yield* Deferred.make<void>()
    const plugin = (version: string, seen: Deferred.Deferred<void>) =>
      define({
        id: "event-listener",
        effect: (ctx) =>
          ctx.event.subscribe(["config.updated", "agent.updated"]).pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => received.push(`${version}:${event.type}`)).pipe(
                Effect.andThen(Deferred.succeed(seen, undefined)),
              ),
            ),
            Effect.forkScoped({ startImmediately: true }),
            Effect.asVoid,
          ),
      })

    yield* plugins.activate([generation(plugin("first", firstSeen), "1")])
    yield* Effect.yieldNow
    yield* bus.publish(ConfigSchema.Event.Updated, {})
    yield* Deferred.await(firstSeen)

    yield* plugins.activate([generation(plugin("second", secondSeen), "2")])
    yield* Effect.yieldNow
    yield* bus.publish(Agent.Event.Updated, {})
    yield* Deferred.await(secondSeen)
    yield* bus.publish(ConfigSchema.Event.Updated, {})
    yield* Effect.yieldNow

    expect(received).toEqual(["first:config.updated", "second:agent.updated", "second:config.updated"])
    yield* plugins.activate([])
    yield* bus.publish(ConfigSchema.Event.Updated, {})
    yield* Effect.yieldNow
    expect(received).toEqual(["first:config.updated", "second:agent.updated", "second:config.updated"])
  }),
)

it.effect("routes multiple selected public events through the tuple Bus delivery", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const bus = yield* Bus.Service
    let wildcardCalls = 0
    const selectedCalls: string[][] = []
    const observedBus = {
      ...bus,
      subscribe: ((input?: Event.Definition | readonly [Event.Definition, ...Event.Definition[]]) => {
        if (input === undefined) {
          wildcardCalls++
          return bus.subscribe()
        }
        if (Array.isArray(input)) {
          const definitions = input as readonly [Event.Definition, ...Event.Definition[]]
          selectedCalls.push(definitions.map((definition) => definition.type))
          return bus.subscribe(definitions)
        }
        return bus.subscribe(input as Event.Definition)
      }) as Bus.Interface["subscribe"],
    }
    const host = yield* PluginHost.make(plugins).pipe(Effect.provideService(Bus.Service, observedBus))
    const received = yield* host.event.subscribe(["agent.updated", "not-a-server-event", "config.updated"]).pipe(
      Stream.take(2),
      Stream.map((event) => event.type),
      Stream.runCollect,
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* Effect.yieldNow

    yield* bus.publish(Agent.Event.Updated, {})
    yield* bus.publish(ConfigSchema.Event.Updated, {})

    expect(Array.from(yield* Fiber.join(received))).toEqual(["agent.updated", "config.updated"])
    expect(wildcardCalls).toBe(0)
    expect(selectedCalls).toEqual([["agent.updated", "config.updated"]])
  }),
)
