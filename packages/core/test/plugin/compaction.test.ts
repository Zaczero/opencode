import { expect } from "bun:test"
import { Effect } from "effect"
import { Plugin } from "@opencode-ai/core/plugin"
import { PluginHooks } from "@opencode-ai/core/plugin/hooks"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { fromPromise } from "@opencode-ai/plugin/promise/adapter"
import { Session } from "@opencode-ai/schema/session"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

it.effect("awaits Promise compaction prompt hooks", () =>
  Effect.gen(function* () {
    const plugin = yield* Plugin.Service
    const hooks = yield* PluginHooks.Service
    const host = yield* PluginHost.make(plugin)
    const seen: string[] = []
    yield* fromPromise({
      id: "promise-session-compaction",
      setup: async (ctx) => {
        await ctx.session.hook("compaction", async (event) => {
          await Promise.resolve()
          seen.push(event.reason)
          event.prompt += "\nPromise tail"
        })
      },
    }).effect(host)
    const event = yield* hooks.trigger("session", "compaction", {
      sessionID: Session.ID.make("ses_promise_session_compaction"),
      reason: "auto",
      context: ["history"],
      prompt: "summary prompt",
    })
    expect(seen).toEqual(["auto"])
    expect(event.prompt).toBe("summary prompt\nPromise tail")
  }),
)
