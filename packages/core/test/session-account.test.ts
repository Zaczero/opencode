import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Credential } from "@opencode/core/credential"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { Integration } from "@opencode/core/integration"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginInternal } from "@opencode/core/plugin/internal"
import { ProjectTable } from "@opencode/core/project/sql"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStep } from "@opencode/core/session/runner/step"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tempLocationLayer } from "./fixture/location"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { makeWebSocketServer } from "./lib/websocket-server"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      PluginInternal.requirements,
      Database.node,
      PluginHooks.node,
      llmClient,
      ModelResolver.node,
      SessionModelRequest.node,
      SessionProjector.node,
      SessionStore.node,
    ]),
    [
      Location.node.replace(tempLocationLayer),
      Config.node.replace(Config.testLayer()),
      Bus.node.replace(Bus.configured({ persist: true })),
      offlineModels,
    ],
  ),
)

const fixture = Effect.gen(function* () {
  const requests: Array<{ headers: Headers; body: { input: readonly unknown[]; prompt_cache_key?: string } }> = []
  const server = yield* makeWebSocketServer({
    async http(request) {
      const body = Schema.decodeUnknownSync(
        Schema.Struct({ input: Schema.Array(Schema.Unknown), prompt_cache_key: Schema.optional(Schema.String) }),
      )(await request.json())
      requests.push({ headers: new Headers(request.headers), body })
      const ordinal = requests.length
      const account = request.headers.get("chatgpt-account-id")
      const output = [
        { type: "reasoning", id: `rs_${ordinal}`, summary: [], encrypted_content: `opaque-${account}-${ordinal}` },
        {
          type: "message",
          id: `msg_${ordinal}`,
          role: "assistant",
          content: [{ type: "output_text", text: `Readable answer from ${account}` }],
        },
      ]
      return new Response(
        [
          ...output.map((item, index) => ({
            type: "response.output_item.done",
            output_index: index,
            item,
          })),
          {
            type: "response.completed",
            response: {
              id: `resp_${ordinal}`,
              status: "completed",
              output,
              usage: { input_tokens: 100, output_tokens: 10 },
            },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const location = yield* Location.Service
  const database = yield* Database.Service
  const store = yield* SessionStore.Service
  const providers = yield* Provider.Service
  const credentials = yield* Credential.Service
  const integrations = yield* Integration.Service
  yield* integrations.transform((editor) =>
    editor.method.update({
      integrationID: Integration.ID.make("openai"),
      method: { type: "oauth", id: Integration.MethodID.make("chatgpt-browser"), label: "Fixture" },
      authorize: () => Effect.die("Login is not part of this fixture"),
      refresh: (value) =>
        Effect.succeed({
          ...value,
          type: "oauth",
          methodID: Integration.MethodID.make("chatgpt-browser"),
          access: "refreshed-token-A",
          refresh: "refreshed-refresh-A",
          expires: 9_999_999_999_999,
        }),
    }),
  )
  const resolver = yield* ModelResolver.Service
  const requestsService = yield* SessionModelRequest.Service
  const step = yield* SessionStep.make
  const sessionID = Session.ID.make("ses_account_scope")
  yield* database.db
    .insert(ProjectTable)
    .values({
      id: location.project.id,
      worktree: location.directory,
      sandboxes: [],
    })
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: location.project.id,
      directory: location.directory,
      title: "Account scope",
      slug: "account-scope",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  const session = yield* store.get(sessionID)
  if (!session) throw new Error("Missing fixture session")
  const selected = {
    ...Model.Info.default(Provider.ID.openai, Model.ID.make("gpt-5")),
    package: "@opencode/ai/providers/openai",
    settings: { baseURL: server.url.replace(/^ws/, "http").replace(/responses$/, "") },
  }
  yield* providers.transform((editor) =>
    editor.update(Provider.ID.openai, (provider) => {
      provider.integrationID = Integration.ID.make("openai")
    }),
  )
  const accounts = yield* Effect.forEach(["A", "B", "C"], (account) =>
    credentials.create({
      integrationID: Integration.ID.make("openai"),
      value: Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("chatgpt-browser"),
        access: `token-${account}`,
        refresh: `refresh-${account}`,
        expires: 9_999_999_999_999,
        metadata: { accountID: account },
      }),
    }),
  )
  const resolve = () => resolver.resolveModel(selected)
  const run = Effect.fn(function* (model: ModelResolver.Resolved, target = session) {
    const history = yield* store.messages({ sessionID: target.id })
    const prepared = yield* requestsService.primary({
      session: target,
      agent: Agent.defaultID,
      model,
      ...SessionModelRequest.baseTranscript({
        agent: Agent.Info.default(Agent.defaultID),
        model,
        tools: { definitions: [], execute: () => Effect.die("No tools") },
        initial: "Account test",
        messages: history,
      }),
    })
    const messageID = SessionMessage.ID.create()
    const result = yield* step.attempt({
      sessionID: target.id,
      assistantMessageID: messageID,
      agent: Agent.defaultID,
      model,
      prepared,
      retry: () => Effect.succeed({ retry: false }),
      recoverContinuation: false,
      recoverOverflow: Effect.succeed(false),
      isLocationClosed: () => false,
    })
    expect(result._tag).toBe("Completed")
    const stored = yield* store.message(messageID)
    if (stored?.message.type !== "assistant") throw new Error("Missing projected assistant")
    expect(stored.message.account).toBe(prepared.account)
    // The compaction estimate anchors on usage by comparing stored scopes with the resolved one.
    if (prepared.account !== undefined) expect(model.account?.scope).toBe(prepared.account)
    return prepared
  })
  return { requests, accounts, credentials, resolve, run, store, sessionID }
})

it.live("binds outgoing encrypted history and cache keys to the actual OpenAI account", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const a = f.accounts[0]
    const b = f.accounts[1]
    const c = f.accounts[2]
    yield* f.credentials.activate(a.id)
    const resolvedA = yield* f.resolve()
    // Selection changes after resolution must not relabel an in-flight request.
    yield* f.credentials.activate(b.id)
    yield* f.run(resolvedA)
    yield* f.run(yield* f.resolve())
    yield* f.credentials.update(a.id, {
      value: {
        ...a.value,
        type: "oauth",
        methodID: Integration.MethodID.make("chatgpt-browser"),
        access: "token-A",
        refresh: "refresh-A",
        expires: 0,
      },
    })
    yield* f.credentials.activate(a.id)
    yield* f.run(yield* f.resolve())
    yield* f.credentials.activate(c.id)
    yield* f.run(yield* f.resolve())

    expect(f.requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer token-A",
      "Bearer token-B",
      "Bearer refreshed-token-A",
      "Bearer token-C",
    ])
    expect(f.requests.map((request) => request.headers.get("chatgpt-account-id"))).toEqual(["A", "B", "A", "C"])
    expect(JSON.stringify(f.requests[1].body.input)).not.toContain("opaque-A")
    expect(JSON.stringify(f.requests[1].body.input)).toContain("Readable answer from A")
    expect(JSON.stringify(f.requests[2].body.input)).toContain("opaque-A-1")
    expect(JSON.stringify(f.requests[2].body.input)).not.toContain("opaque-B")
    expect(JSON.stringify(f.requests[3].body.input)).not.toContain("opaque-")
    const keys = f.requests.map((request) => request.body.prompt_cache_key)
    expect(keys.every((key) => typeof key === "string" && /^[0-9a-f]{64}$/.test(key))).toBe(true)
    expect(keys[0]).toBe(keys[2])
    expect(new Set(keys).size).toBe(3)
  }),
)

it.live("omits opaque history and cache affinity when a late HTTP hook changes accounts", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const hooks = yield* PluginHooks.Service
    yield* f.credentials.activate(f.accounts[0].id)
    yield* f.run(yield* f.resolve())
    yield* hooks.register("session", "http.request", (event) =>
      Effect.sync(() => {
        event.request.headers.set("authorization", "Bearer late-token-B")
        event.request.headers.set("chatgpt-account-id", "B")
      }),
    )
    const prepared = yield* f.run(yield* f.resolve())
    expect(prepared.account).toBeUndefined()
    expect(f.requests[1].headers.get("authorization")).toBe("Bearer late-token-B")
    expect(f.requests[1].body.prompt_cache_key).toBeUndefined()
    expect(JSON.stringify(f.requests[1].body.input)).not.toContain("opaque-")
    expect(JSON.stringify(f.requests[1].body.input)).toContain("Readable answer from A")
  }),
)

it.live("does not adopt old opaque history whose account provenance is missing", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.credentials.activate(f.accounts[0].id)
    const known = yield* f.resolve()
    yield* f.run({ ...known, account: undefined })
    yield* f.run(known)
    expect(f.requests[0].body.prompt_cache_key).toBeUndefined()
    expect(f.requests[1].body.prompt_cache_key).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(f.requests[1].body.input)).not.toContain("opaque-")
    expect(JSON.stringify(f.requests[1].body.input)).toContain("Readable answer from A")
  }),
)

it.live("isolates API keys belonging to the same provider", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const first = yield* f.credentials.create({
      integrationID: Integration.ID.make("openai"),
      value: { type: "key", key: "sk-first-account" },
    })
    yield* f.run(yield* f.resolve())
    yield* f.credentials.create({
      integrationID: Integration.ID.make("openai"),
      value: { type: "key", key: "sk-second-account" },
    })
    yield* f.run(yield* f.resolve())
    yield* f.credentials.activate(first.id)
    yield* f.run(yield* f.resolve())
    expect(f.requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer sk-first-account",
      "Bearer sk-second-account",
      "Bearer sk-first-account",
    ])
    expect(f.requests[0].body.prompt_cache_key).toMatch(/^[0-9a-f]{64}$/)
    expect(f.requests[1].body.prompt_cache_key).not.toBe(f.requests[0].body.prompt_cache_key)
    expect(f.requests[2].body.prompt_cache_key).toBe(f.requests[0].body.prompt_cache_key)
    expect(JSON.stringify(f.requests[1].body.input)).not.toContain("opaque-")
    expect(JSON.stringify(f.requests[2].body.input)).toContain("opaque-null-1")
  }),
)

it.live("preserves the producing account through a fork without adopting another account's state", () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const sessions = yield* Session.Service
    yield* f.credentials.activate(f.accounts[0].id)
    yield* f.run(yield* f.resolve())
    const fork = yield* sessions.fork({ sessionID: f.sessionID })
    yield* f.run(yield* f.resolve(), fork)
    expect(JSON.stringify(f.requests[1].body.input)).toContain("opaque-A-1")
    expect(f.requests[1].body.prompt_cache_key).toBe(f.requests[0].body.prompt_cache_key)
    yield* f.credentials.activate(f.accounts[1].id)
    yield* f.run(yield* f.resolve(), fork)
    expect(JSON.stringify(f.requests[2].body.input)).not.toContain("opaque-A")
    expect(f.requests[2].body.prompt_cache_key).not.toBe(f.requests[1].body.prompt_cache_key)
  }),
)

it.live("replays signed Anthropic thinking within its account scope", () =>
  Effect.gen(function* () {
    const bodies: Array<{ messages: ReadonlyArray<{ role: string; content: unknown }> }> = []
    const server = yield* makeWebSocketServer({
      async http(request) {
        bodies.push(
          Schema.decodeUnknownSync(
            Schema.Struct({
              messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
            }),
          )(await request.json()),
        )
        const ordinal = bodies.length
        const events = [
          {
            type: "message_start",
            message: {
              id: `msg_${ordinal}`,
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-5",
              content: [],
              usage: { input_tokens: 100, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: `Reasoning ${ordinal}` } },
          { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: `sig-${ordinal}` } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: `Answer ${ordinal}` } },
          { type: "content_block_stop", index: 1 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } },
          { type: "message_stop" },
        ]
        return new Response(
          events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const f = yield* fixture
    const anthropic = Provider.ID.make("anthropic")
    const selected = {
      ...Model.Info.default(anthropic, Model.ID.make("claude-sonnet-4-5")),
      package: "@opencode/ai/providers/anthropic",
      settings: {
        baseURL: `${server.url.replace(/^ws/, "http").replace(/responses$/, "")}v1`,
        apiKey: "sk-ant-fixture",
      },
    }
    const resolver = yield* ModelResolver.Service
    const first = yield* f.run(yield* resolver.resolveModel(selected))
    expect(first.account).toMatch(/^[0-9a-f]{64}$/)
    yield* f.run(yield* resolver.resolveModel(selected))
    expect(bodies[1].messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Reasoning 1", signature: "sig-1" },
          { type: "text", text: "Answer 1", cache_control: { type: "ephemeral" } },
        ],
      },
    ])
  }),
)
