import { describe, expect } from "bun:test"
import { ToolFailure } from "@opencode-ai/ai"
import { Context, Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect"
import { Plugin as EffectPlugin } from "@opencode-ai/plugin/effect"
import { Config as ConfigSchema } from "@opencode-ai/schema/config"
import { Event } from "@opencode-ai/schema/event"
import { McpEvent } from "@opencode-ai/schema/mcp-event"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { Agent } from "@opencode-ai/core/agent"
import { Bus } from "@opencode-ai/core/bus"
import { Plugin } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { PluginRuntime } from "@opencode-ai/core/plugin/runtime"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Tool } from "@opencode-ai/core/tool"
import { Vcs } from "@opencode-ai/core/vcs"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

class Secret extends Context.Service<Secret, string>()("@opencode/test/PluginSecret") {}

const versioned = <R>(plugin: EffectPlugin.Plugin<R>, version = "1") => ({ ...plugin, version })

describe("Plugin", () => {
  it.effect("exposes the current location to activated plugins", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const location = yield* Location.Service
      const seen: Location.Info[] = []
      yield* plugins.activate([
        versioned(
          EffectPlugin.define({
            id: "location-context",
            effect: (ctx) =>
              Effect.sync(() => {
                seen.push(ctx.location)
              }),
          }),
          "1",
        ),
      ])

      expect(seen).toEqual([
        new Location.Info({
          directory: location.directory,
          workspaceID: location.workspaceID,
          project: location.project,
        }),
      ])
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
      yield* bus.publish(SessionEvent.Synthetic, { sessionID: Session.ID.create(), text: "synthetic" })

      expect(Array.from(yield* Fiber.join(received), (event) => event.type)).toEqual([
        "config.updated",
        "session.synthetic",
      ])
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

      yield* bus.publish(SessionEvent.Synthetic, { sessionID: Session.ID.create(), text: "filtered" })
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
        EffectPlugin.define({
          id: "event-listener",
          effect: (ctx) =>
            ctx.event
              .subscribe(["config.updated"])
              .pipe(
                Stream.runForEach(() =>
                  Effect.sync(() => received.push(version)).pipe(Effect.andThen(Deferred.succeed(seen, undefined))),
                ),
                Effect.forkScoped({ startImmediately: true }),
                Effect.asVoid,
              ),
        })

      yield* plugins.activate([versioned(plugin("first", firstSeen), "1")])
      yield* Effect.yieldNow
      yield* bus.publish(ConfigSchema.Event.Updated, {})
      yield* Deferred.await(firstSeen)

      yield* plugins.activate([versioned(plugin("second", secondSeen), "2")])
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
        EffectPlugin.define({
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

      yield* plugins.activate([versioned(plugin("first", firstSeen), "1")])
      yield* Effect.yieldNow
      yield* bus.publish(ConfigSchema.Event.Updated, {})
      yield* Deferred.await(firstSeen)

      yield* plugins.activate([versioned(plugin("second", secondSeen), "2")])
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

  it.effect("exposes MCP reads and transforms and routes explicit read locations", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const runtime = yield* PluginRuntime.Service
      const target = AbsolutePath.make("/target")
      const routed: string[] = []
      const host = yield* PluginHost.make(plugins).pipe(
        Effect.provideService(
          PluginRuntime.Service,
          PluginRuntime.Service.of({
            ...runtime,
            location: {
              agent: runtime.location.agent,
              mcp: {
                list: (ref) =>
                  Effect.sync(() => {
                    routed.push(`list:${ref.directory}`)
                    return {
                      location: new Location.Info({
                        directory: ref.directory,
                        project: {
                          id: Project.ID.make("project"),
                          directory: ref.directory,
                          canonical: ref.directory,
                        },
                      }),
                      data: [],
                    }
                  }),
              },
            },
          }),
        ),
      )
      const location = { directory: target }

      expect(Object.keys(host.mcp).sort()).toEqual(["list", "reload", "transform"])
      expect((yield* host.mcp.list({ location }).pipe(Effect.orDie)).location.directory).toBe(target)
      expect(routed).toEqual(["list:/target"])
    }),
  )

  it.effect("registers and removes scoped VCS providers", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const vcs = yield* Vcs.Service
      const provider = EffectPlugin.define({
        id: "custom-vcs",
        effect: (ctx) =>
          ctx.vcs
            .transform((draft) => {
              draft.add({
                id: "custom",
                name: "Custom VCS",
                info: () => Effect.succeed({ branch: { current: "feature" } }),
                branches: () => Effect.succeed(["feature"]),
                status: () => Effect.succeed([]),
                diff: () => Effect.succeed([]),
              })
              draft.default.set("custom")
            })
            .pipe(Effect.asVoid),
      })

      yield* plugins.activate([versioned(provider)])
      expect(yield* vcs.info()).toEqual({ branch: { current: "feature" } })
      expect(yield* vcs.branches()).toEqual(["feature"])

      yield* plugins.activate([])
      expect(yield* vcs.info()).toEqual({ branch: {} })
    }),
  )

  it.effect("replaces plugins by ID and version", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const agents = yield* Agent.Service
      const bus = yield* Bus.Service
      let description = "first"
      let updates = 0
      const unsubscribe = yield* bus.listen((event) =>
        Effect.sync(() => {
          if (event.type === Plugin.Event.Updated.type) updates++
        }),
      )

      const managed = () =>
        EffectPlugin.define({
          id: "managed",
          effect: (ctx) =>
            ctx.agent
              .transform((agents) =>
                agents.update("configured", (agent) => {
                  agent.description = description
                }),
              )
              .pipe(Effect.asVoid),
        })

      yield* plugins.activate([versioned(managed(), "1")])

      expect((yield* agents.get(Agent.ID.make("configured")))?.description).toBe("first")

      description = "second"
      yield* plugins.activate([versioned(managed(), "2")])
      expect((yield* agents.get(Agent.ID.make("configured")))?.description).toBe("second")

      description = "third"
      yield* plugins.activate([versioned(managed(), "2")])
      expect(updates).toBe(2)
      expect((yield* agents.get(Agent.ID.make("configured")))?.description).toBe("second")

      yield* plugins.activate(
        [versioned(managed(), "2")],
        [
          {
            source: { type: "package", package: "broken" },
            status: "failed",
            error: "failed to resolve",
            tui: false,
          },
        ],
      )
      expect(updates).toBe(3)

      yield* plugins.activate([])
      expect(yield* agents.get(Agent.ID.make("configured"))).toBeUndefined()
      expect(updates).toBe(4)
      yield* unsubscribe
    }),
  )

  it.effect("emits rebuilt state when disabling one plugin while another remains enabled", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const agents = yield* Agent.Service
      const bus = yield* Bus.Service
      const definitions = ["first", "second"].map((id) =>
        versioned(
          EffectPlugin.define({
            id,
            effect: (ctx) => ctx.agent.transform((draft) => draft.update(id, () => {})),
          }),
        ),
      )
      yield* plugins.activate(definitions)

      const observed: string[][] = []
      const unsubscribe = yield* bus.listen((event) =>
        event.type === Agent.Event.Updated.type
          ? agents.list().pipe(
              Effect.flatMap((items) => Effect.sync(() => observed.push(items.map((item) => item.id)))),
              Effect.asVoid,
            )
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* plugins.activate(definitions.slice(1))
      expect(yield* agents.get(Agent.ID.make("first"))).toBeUndefined()
      expect(yield* agents.get(Agent.ID.make("second"))).toBeDefined()
      expect(observed).toEqual([["second"]])
    }),
  )

  it.effect("rejects duplicate IDs before replacing active plugins", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const active = Plugin.ID.make("active")
      const duplicate = "duplicate"
      yield* plugins.activate([{ id: active, version: "1", effect: () => Effect.void }])

      const result = yield* plugins
        .activate([
          { id: duplicate, version: "1", effect: () => Effect.void },
          { id: duplicate, version: "1", effect: () => Effect.void },
        ])
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* plugins.list()).toEqual([{ id: active, source: { type: "builtin" }, status: "active", tui: false }])
    }),
  )

  it.effect("skips failed plugins and loads the rest", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const agents = yield* Agent.Service
      let fail = true
      const good = EffectPlugin.define({
        id: "good",
        effect: (ctx) =>
          ctx.agent
            .transform((agents) =>
              agents.update("configured", (agent) => {
                agent.description = "loaded"
              }),
            )
            .pipe(Effect.asVoid),
      })
      const bad = EffectPlugin.define({
        id: "bad",
        effect: () => {
          if (fail) return Effect.die(new Error("materialization failed"))
          return Effect.void
        },
      })

      yield* plugins.activate([versioned(good), versioned(bad)])
      expect(yield* plugins.list()).toEqual([
        { id: Plugin.ID.make("good"), source: { type: "builtin" }, status: "active", tui: false },
        {
          id: Plugin.ID.make("bad"),
          source: { type: "builtin" },
          status: "failed",
          error: expect.stringContaining("materialization failed"),
          tui: false,
        },
      ])
      expect((yield* agents.get(Agent.ID.make("configured")))?.description).toBe("loaded")

      fail = false
      yield* plugins.activate([versioned(good), versioned(bad, "2")])
      expect(yield* plugins.list()).toEqual([
        { id: Plugin.ID.make("good"), source: { type: "builtin" }, status: "active", tui: false },
        { id: Plugin.ID.make("bad"), source: { type: "builtin" }, status: "active", tui: false },
      ])
    }),
  )

  it.effect("keeps plugins active when a tool registration is invalid", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const tools = yield* Tool.Service
      const agents = yield* Agent.Service
      yield* plugins.activate([
        {
          id: "partial-tools",
          version: "1",
          effect: (ctx) =>
            Effect.gen(function* () {
              yield* ctx.tool.transform((draft) => {
                const tool = {
                  name: "healthy",
                  description: "Healthy tool",
                  input: Schema.Struct({}),
                  execute: () => Effect.succeed({ content: "ok" }),
                  options: { codemode: false },
                }
                draft.add({ ...tool, name: "invalid", options: { namespace: "invalid..namespace" } })
                draft.add(tool)
              })
              yield* ctx.agent.transform((draft) =>
                draft.update("configured", (agent) => {
                  agent.description = "setup continued"
                }),
              )
            }),
        },
      ])

      expect(yield* plugins.list()).toEqual([
        { id: Plugin.ID.make("partial-tools"), source: { type: "builtin" }, status: "active", tui: false },
      ])
      expect((yield* agents.get(Agent.ID.make("configured")))?.description).toBe("setup continued")
      expect((yield* tools.snapshot()).definitions.map((tool) => tool.name)).toEqual(["healthy", "execute"])
      yield* plugins.activate([])
      expect((yield* tools.snapshot()).definitions.map((tool) => tool.name)).toEqual(["execute"])
    }),
  )

  it.effect("restores the previous plugin when its replacement fails", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const agents = yield* Agent.Service
      const previous = EffectPlugin.define({
        id: "managed",
        effect: (ctx) =>
          ctx.agent
            .transform((agents) =>
              agents.update("configured", (agent) => {
                agent.description = "previous"
              }),
            )
            .pipe(Effect.asVoid),
      })
      const replacement = EffectPlugin.define({
        id: "managed",
        effect: (ctx) =>
          Effect.gen(function* () {
            yield* ctx.agent.transform((agents) =>
              agents.update("configured", (agent) => {
                agent.description = "replacement"
              }),
            )
            return yield* Effect.die(new Error("replacement failed"))
          }),
      })

      yield* plugins.activate([versioned(previous)])
      yield* plugins.activate([versioned(replacement, "2")])

      expect(yield* plugins.list()).toEqual([
        {
          id: Plugin.ID.make("managed"),
          source: { type: "builtin" },
          status: "failed",
          error: expect.stringContaining("replacement failed"),
          tui: false,
        },
      ])
      expect((yield* agents.get(Agent.ID.make("configured")))?.description).toBe("previous")
    }),
  )

  it.effect("deactivates a plugin when replacement and restoration fail", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const agents = yield* Agent.Service
      let loads = 0
      const previous = EffectPlugin.define({
        id: "managed",
        effect: (ctx) => {
          loads++
          if (loads > 1) return Effect.die(new Error("restoration failed"))
          return ctx.agent
            .transform((agents) =>
              agents.update("configured", (agent) => {
                agent.description = "previous"
              }),
            )
            .pipe(Effect.asVoid)
        },
      })
      const replacement = EffectPlugin.define({
        id: "managed",
        effect: () => Effect.die(new Error("replacement failed")),
      })

      yield* plugins.activate([versioned(previous)])
      yield* plugins.activate([versioned(replacement, "2")])

      expect(yield* plugins.list()).toEqual([
        {
          id: Plugin.ID.make("managed"),
          source: { type: "builtin" },
          status: "failed",
          error: expect.stringContaining("replacement failed"),
          tui: false,
        },
      ])
      expect(yield* agents.get(Agent.ID.make("configured"))).toBeUndefined()
    }),
  )

  it.effect("closes the previous generation in reverse order", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const closed: string[] = []
      yield* plugins.activate(
        ["first", "second"].map((id) => ({
          id,
          version: "1",
          effect: () => Effect.addFinalizer(() => Effect.sync(() => closed.push(id))),
        })),
      )

      yield* plugins.activate([])

      expect(closed).toEqual(["second", "first"])
    }),
  )

  it.effect("isolates plugins from ambient services", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      let visible = true
      const plugin = EffectPlugin.define({
        id: "isolated",
        effect: () =>
          Effect.serviceOption(Secret).pipe(
            Effect.tap((secret) => Effect.sync(() => (visible = secret._tag === "Some"))),
            Effect.asVoid,
          ),
      })

      yield* plugins.activate([versioned(plugin)]).pipe(Effect.provideService(Secret, "secret"))

      expect(visible).toBe(false)
    }),
  )

  it.effect("provides isolated durable storage for each plugin ID", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const storage = new Map<string, EffectPlugin.Context["storage"]>()
      yield* plugins.activate(
        ["a", "a:b", "雪"].map((id) => ({
          id,
          version: "1",
          effect: (context: EffectPlugin.Context) => Effect.sync(() => storage.set(id, context.storage)),
        })),
      )
      const first = storage.get("a")
      const second = storage.get("a:b")
      const unicode = storage.get("雪")
      if (!first || !second || !unicode) return yield* Effect.die("plugin storage was not activated")

      yield* first.set("b:c", { plugin: "a" })
      yield* second.set("c", { plugin: "a:b" })
      yield* unicode.set("c", { plugin: "雪" })
      expect(yield* first.get("b:c")).toEqual({ plugin: "a" })
      expect(yield* second.get("c")).toEqual({ plugin: "a:b" })
      expect(yield* unicode.get("c")).toEqual({ plugin: "雪" })
      expect(yield* first.get("c")).toBeUndefined()

      const prefix = "%_:/雪/"
      yield* first.set(`${prefix}beta`, [2])
      yield* first.set(`${prefix}alpha`, [1])
      const firstPage = yield* first.scan({ prefix, limit: 1 })
      expect(firstPage).toEqual({ entries: [{ key: `${prefix}alpha`, value: [1] }], next: `${prefix}alpha` })
      expect(yield* first.scan({ prefix, after: firstPage.next, limit: 1 })).toEqual({
        entries: [{ key: `${prefix}beta`, value: [2] }],
      })
      expect(yield* first.scan({ prefix: `${prefix}%_` })).toEqual({ entries: [] })
      expect(yield* first.scan({ prefix: "" })).toEqual({
        entries: [
          { key: `${prefix}alpha`, value: [1] },
          { key: `${prefix}beta`, value: [2] },
          { key: "b:c", value: { plugin: "a" } },
        ],
      })

      yield* first.remove("b:c")
      yield* first.remove("b:c")
      expect(yield* first.get("b:c")).toBeUndefined()
      return undefined
    }),
  )

  it.effect("registers location tools through the plugin context", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const registry = yield* Tool.Service
      const plugin = EffectPlugin.define({
        id: "tool-plugin",
        effect: (ctx) =>
          ctx.tool
            .transform((draft) =>
              draft.add({
                name: "plugin_tool",
                options: { codemode: false },
                description: "Plugin tool",
                input: Schema.Struct({}),
                output: Schema.Struct({ ok: Schema.Boolean }),
                execute: () => Effect.succeed({ output: { ok: true } }),
              }),
            )
            .pipe(Effect.orDie),
      })

      yield* plugins.activate([versioned(plugin)])
      expect((yield* registry.snapshot()).definitions.map((tool) => tool.name)).toContain("plugin_tool")

      yield* plugins.activate([])
      expect((yield* registry.snapshot()).definitions.map((tool) => tool.name)).not.toContain("plugin_tool")
    }),
  )

  it.effect("namespaces tool names and routes codemode registrations through execute", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const registry = yield* Tool.Service
      const tool = (name: string, description: string, options?: Tool.Options) => ({
        name,
        options,
        description,
        input: Schema.Struct({}),
        output: Schema.Struct({ ok: Schema.Boolean }),
        execute: () => Effect.succeed({ output: { ok: true } }),
      })
      const plugin = EffectPlugin.define({
        id: "grouped-tools",
        effect: (ctx) =>
          ctx.tool
            .transform((draft) => {
              draft.add(tool("plain", "Plain", { codemode: false }))
              draft.add(tool("look/up", "Lookup", { namespace: "context7", codemode: false }))
              draft.add(tool("search", "Search", { namespace: "context7" }))
            })
            .pipe(Effect.orDie),
      })

      yield* plugins.activate([versioned(plugin)])

      expect((yield* registry.snapshot()).definitions.map((tool) => tool.name)).toEqual([
        "context7_look_up",
        "plain",
        "execute",
      ])
    }),
  )

  it.effect("fires before/after tool hooks with mutable events around execution", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const registry = yield* Tool.Service
      const executed: unknown[] = []
      const seen: {
        before?: { input: unknown; tool: string }
        after?: { input: unknown; status: string; content: unknown; metadata: unknown }
      } = {}

      const plugin = EffectPlugin.define({
        id: "tool-hooks",
        effect: (ctx) =>
          Effect.gen(function* () {
            yield* ctx.tool
              .transform((draft) =>
                draft.add({
                  name: "echo",
                  options: { codemode: false },
                  description: "Echo",
                  input: Schema.Struct({ text: Schema.String }),
                  output: Schema.Struct({ text: Schema.String }),
                  execute: ({ text }) =>
                    Effect.sync(() => executed.push({ text })).pipe(Effect.as({ output: { text } })),
                }),
              )
              .pipe(Effect.orDie)

            yield* ctx.tool
              .hook("execute.before", (event) =>
                Effect.sync(() => {
                  expect(event).not.toHaveProperty("inputSchema")
                  seen.before = { input: event.input, tool: event.tool }
                  event.tool = "echo"
                  event.input = { text: "before-mutated" }
                }),
              )
              .pipe(Effect.asVoid)

            yield* ctx.tool
              .hook("execute.after", (event) =>
                Effect.sync(() => {
                  seen.after = {
                    input: event.input,
                    status: event.status,
                    content: event.status === "completed" ? event.result.content : undefined,
                    metadata: event.status === "completed" ? event.result.metadata : event.error.metadata,
                  }
                  if (event.status !== "completed") return
                  event.result = {
                    ...event.result,
                    content: [{ type: "text", text: "after-mutated" }],
                    metadata: { rewritten: true },
                  }
                }),
              )
              .pipe(Effect.asVoid)

            yield* ctx.tool
              .hook("execute.after", (event) =>
                Effect.sync(() => {
                  if (event.status === "completed" && Array.isArray(event.result.content))
                    event.result.content.splice(0)
                }),
              )
              .pipe(Effect.asVoid)
          }),
      })

      yield* plugins.activate([versioned(plugin)])

      const toolSet = yield* registry.snapshot()
      const execution = yield* toolSet.execute({
        sessionID: Session.ID.make("ses_hooks"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_hooks"),
        call: { type: "tool-call", id: "call-hooks", name: "misspelled", input: { text: "original" } },
      })

      expect(seen.before).toEqual({
        input: { text: "original" },
        tool: "misspelled",
      })
      expect(executed).toEqual([{ text: "before-mutated" }])
      expect(seen.after).toEqual({
        input: { text: "before-mutated" },
        status: "completed",
        content: [{ type: "text", text: '{"text":"before-mutated"}' }],
        metadata: undefined,
      })
      expect(execution).toMatchObject({
        content: [{ type: "text", text: '{"text":"before-mutated"}' }],
        metadata: { rewritten: true },
      })
    }),
  )

  it.effect("rejects tool execution when an execute.before hook fails", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const registry = yield* Tool.Service
      const executed: unknown[] = []

      const plugin = EffectPlugin.define({
        id: "tool-hook-reject",
        effect: (ctx) =>
          Effect.gen(function* () {
            yield* ctx.tool
              .transform((draft) =>
                draft.add({
                  name: "echo",
                  options: { codemode: false },
                  description: "Echo",
                  input: Schema.Struct({ text: Schema.String }),
                  output: Schema.Struct({ text: Schema.String }),
                  execute: ({ text }) =>
                    Effect.sync(() => executed.push({ text })).pipe(Effect.as({ output: { text } })),
                }),
              )
              .pipe(Effect.orDie)

            yield* ctx.tool
              .hook("execute.before", () => new ToolFailure({ message: "write disabled" }))
              .pipe(Effect.asVoid)
          }),
      })

      yield* plugins.activate([versioned(plugin)])

      const toolSet = yield* registry.snapshot()
      const failure = yield* toolSet
        .execute({
          sessionID: Session.ID.make("ses_hook_reject"),
          agent: Agent.ID.make("build"),
          messageID: SessionMessage.ID.make("msg_hook_reject"),
          call: { type: "tool-call", id: "call-hook-reject", name: "missing", input: { text: "original" } },
        })
        .pipe(Effect.flip)

      expect(failure).toMatchObject({ _tag: "Tool.Error", message: "write disabled" })
      expect(executed).toEqual([])
    }),
  )
})
