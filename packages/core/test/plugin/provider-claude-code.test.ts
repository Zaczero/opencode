import { expect } from "bun:test"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { Document, Info } from "@opencode/schema/config"
import { Effect, Schema } from "effect"
import { Config } from "@opencode/core/config"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { ModelAccount } from "@opencode/core/model-account"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { make } from "@opencode/core/plugin/provider/claude-code"
import { Provider } from "@opencode/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const anthropic = Provider.ID.make("anthropic")
const claudeCode = Provider.ID.make("claude-code")
const opus = Model.ID.make("opus")
const opusLatest = Model.ID.make("claude-opus-5-5")
// Claude Code resolves its own aliases; the SDK's bundled binary answers without a login or a model call.
const bundled = createRequire(
  createRequire(import.meta.resolve("@opencode/ai/providers/claude-code")).resolve("@anthropic-ai/claude-agent-sdk"),
).resolve("@anthropic-ai/claude-agent-sdk-linux-x64/claude")

const login = () => {
  const root = mkdtempSync(path.join(tmpdir(), "claude-code-provider-"))
  const bin = path.join(root, "bin")
  mkdirSync(bin)
  symlinkSync(bundled, path.join(bin, "claude"))
  writeFileSync(
    path.join(root, ".claude.json"),
    JSON.stringify({ oauthAccount: { organizationUuid: "org", accountUuid: "acct" } }),
  )
  return { CLAUDE_CONFIG_DIR: root, HOME: root, PATH: bin, executable: path.join(bin, "claude") }
}

const anthropicCatalog = (host: Parameters<ReturnType<typeof make>["effect"]>[0]) =>
  host.provider.transform((editor) =>
    editor.add({
      info: { ...Provider.Info.empty(anthropic), package: "@opencode/ai/providers/anthropic" },
      models: [
        {
          ...Model.Info.default(anthropic, opusLatest),
          limit: { context: 200_000, output: 64_000 },
          cost: [
            {
              input: 5,
              output: 25,
              cache: { read: 0.5, write: 6.25 },
            } as unknown as Model.Info["cost"][number],
          ],
        },
      ],
    }),
  )

it.live("offers Claude Code's aliases as their newest models with standard limit config", () =>
  Effect.gen(function* () {
    const env = login()
    const plugin = yield* Plugin.Service
    const host = yield* PluginHost.make(plugin)
    const location = yield* Location.Service
    yield* anthropicCatalog(host)
    yield* make(env).effect(host)
    yield* ConfigProviderPlugin.Plugin.effect(host).pipe(
      Effect.provide(
        Config.testLayer([
          new Document({
            type: "document",
            info: Schema.decodeUnknownSync(Info)({
              providers: {
                "claude-code": {
                  models: { opus: { limit: { context: 532_000, input: 902_000, compaction: 400_000 } } },
                },
              },
            }),
          }),
        ]),
      ),
    )

    const model = yield* Model.Service
    const catalog = yield* model.get(claudeCode, opus)
    if (!catalog) throw new Error("Claude Code model missing")
    expect(catalog.modelID).toBe(opusLatest)
    expect(catalog.limit).toEqual({ context: 532_000, input: 902_000, output: 64_000, compaction: 400_000 })
    expect((yield* model.get(claudeCode, Model.ID.make("sonnet")))?.modelID).toMatch(/^claude-sonnet-/)
    expect(yield* model.get(claudeCode, opusLatest)).toBeUndefined()
    expect(catalog.cost).toEqual([])
    const provider = yield* (yield* Provider.Service).get(claudeCode)
    expect(provider?.package).toBe("@opencode/ai/providers/claude-code")
    expect(provider?.settings).toMatchObject({ account: "org/acct", executable: env.executable })
    expect(catalog.settings).toMatchObject({ directory: location.directory, project: location.project.canonical })

    const resolved = yield* ModelResolver.resolveModel(
      { ...catalog, package: provider?.package, settings: Provider.mergeOverlay(provider?.settings, catalog.settings) },
      undefined,
    )
    expect(resolved.route.id).toBe("claude-code")
    expect(String(resolved.id)).toBe("claude-opus-5-5")
    expect(ModelAccount.scope("identity", resolved)).toMatch(/^[0-9a-f]{64}$/)
  }),
  // Resolving the aliases starts the bundled Claude Code, which a loaded host slows well past the default.
  60_000,
)

it.live("lends an alias the newest catalog model of its family when the catalog predates it", () =>
  Effect.gen(function* () {
    const env = login()
    const plugin = yield* Plugin.Service
    const host = yield* PluginHost.make(plugin)
    yield* host.provider.transform((editor) =>
      editor.add({
        info: { ...Provider.Info.empty(anthropic), package: "@opencode/ai/providers/anthropic" },
        models: [
          {
            ...Model.Info.default(anthropic, Model.ID.make("claude-opus-4-8")),
            limit: { context: 200_000, output: 32_000 },
          },
          {
            ...Model.Info.default(anthropic, Model.ID.make("claude-opus-5")),
            limit: { context: 1_000_000, output: 128_000 },
          },
        ],
      }),
    )
    yield* make(env).effect(host)
    const catalog = yield* (yield* Model.Service).get(claudeCode, opus)
    expect(catalog?.modelID).toBe(opusLatest)
    // Until the catalog knows the model, it carries Claude Code's own display name.
    expect(catalog?.name).toMatch(/Opus/)
    expect(catalog?.limit).toEqual({ context: 1_000_000, output: 128_000 })
    expect(catalog?.variants.map((variant) => String(variant.id))).toContain("max")
  }),
  // Resolving the aliases starts the bundled Claude Code, which a loaded host slows well past the default.
  60_000,
)

it.live("stays absent without a Claude Code login", () =>
  Effect.gen(function* () {
    const env = { ...login(), CLAUDE_CONFIG_DIR: mkdtempSync(path.join(tmpdir(), "claude-code-logged-out-")) }
    const plugin = yield* Plugin.Service
    const host = yield* PluginHost.make(plugin)
    yield* anthropicCatalog(host)
    yield* make(env).effect(host)
    expect(yield* (yield* Provider.Service).get(claudeCode)).toBeUndefined()
  }),
)
