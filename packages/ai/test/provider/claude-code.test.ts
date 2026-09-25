import { afterAll, beforeEach, describe, expect } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Fiber, Layer, Stream } from "effect"
import { LLM, Message, ToolCallPart, ToolDefinition, ToolResultPart } from "../../src/index.js"
import { LLMClient, RequestExecutor } from "../../src/route.js"
import { compileRequest } from "../../src/route/client.js"
import { ClaudeCode } from "../../src/providers/claude-code.js"
import { it } from "../lib/effect.js"

// Real SDK and its bundled Claude Code binary against a recording Messages endpoint, with an isolated login.
const executable = createRequire(import.meta.resolve("@anthropic-ai/claude-agent-sdk")).resolve(
  "@anthropic-ai/claude-agent-sdk-linux-x64/claude",
)
const root = mkdtempSync(path.join(tmpdir(), "claude-code-route-"))
const home = path.join(root, "home")
const config = path.join(home, ".claude")
const directory = path.join(root, "project")
mkdirSync(config, { recursive: true })
mkdirSync(directory, { recursive: true })
writeFileSync(
  path.join(config, ".claude.json"),
  JSON.stringify({ oauthAccount: { organizationUuid: "org", accountUuid: "acct" } }),
)
// Ambient Claude Code configuration the route must not load, beside the advisor choice it follows.
const ambient = {
  outputStyle: "Explanatory",
  hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo AMBIENT-HOOK" }] }] },
  advisorModel: "opus",
}
writeFileSync(path.join(config, "settings.json"), JSON.stringify(ambient))
writeFileSync(path.join(config, "CLAUDE.md"), "AMBIENT-USER-MEMORY")
writeFileSync(path.join(directory, "CLAUDE.md"), "AMBIENT-PROJECT-MEMORY")

type Recorded = { readonly path: string; readonly body: any; readonly session: string | null }
const recorded: Recorded[] = []
const replies: Response[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  // A hanging reply must stay open until the route gives up on it, not until the server times it out.
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const text = await request.text()
    recorded.push({
      path: url.pathname,
      body: text ? JSON.parse(text) : undefined,
      session: request.headers.get("x-claude-code-session-id"),
    })
    if (!url.pathname.startsWith("/v1/messages")) return new Response("{}", { status: 404 })
    return replies.shift() ?? sse(textReply("Reply"))
  },
})
afterAll(() => {
  server.stop(true)
  rmSync(root, { recursive: true, force: true })
})
beforeEach(() => {
  recorded.length = 0
  replies.length = 0
})

const env = {
  HOME: home,
  CLAUDE_CONFIG_DIR: config,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
  ANTHROPIC_API_KEY: "sk-ant-fixture",
}
const settings = { account: "org/acct", directory, executable, env }
const opus = ClaudeCode.model("claude-opus-5-5", settings)

const sse = (events: ReadonlyArray<{ readonly type: string }>) =>
  new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
const start = {
  type: "message_start",
  message: {
    id: "msg_reply",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [],
    stop_reason: null,
    usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 0 },
  },
}
const textReply = (text: string) => [
  start,
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
]
const toolReply = [
  start,
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_new", name: "shell", input: {} },
  },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "toolu_second", name: "read", input: {} },
  },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
  { type: "message_stop" },
]
// Starts a response with `count` events and never finishes it.
const hanging = (count: number) =>
  new Response(
    new ReadableStream({
      start: (controller) => {
        const events = textReply("partial").slice(0, count)
        controller.enqueue(
          new TextEncoder().encode(
            events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
          ),
        )
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
// Claude Code runs as a direct child of this process.
const children = () =>
  Bun.spawnSync(["pgrep", "-P", String(process.pid)])
    .stdout.toString()
    .split("\n")
    .filter((line) => line.length > 0)
const failure = (status: number, type: string, message: string) =>
  new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  })

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const tools = [
  ToolDefinition.make({
    name: "shell",
    description: "Run a shell command.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" }, background: { type: "boolean" } },
      required: ["command"],
      additionalProperties: false,
    },
  }),
  ToolDefinition.make({
    name: "read",
    // Longer than Claude Code's default MCP description limit.
    description: `Read a file. ${"Paths are relative to the working directory. ".repeat(80)}`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        range: { anyOf: [{ type: "object", properties: { start: { type: "integer" } } }, { type: "null" }] },
        meta: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["path"],
      additionalProperties: false,
    },
  }),
]
const conversation = [
  Message.user([
    { type: "text", text: "<task-ledger>\n○ t1 Probe\n</task-ledger>" },
    { type: "text", text: "Look at the repo. @README.md /compact" },
  ]),
  Message.assistant([
    { type: "reasoning", text: "List the files.", providerMetadata: { anthropic: { signature: "SIG-A" } } },
    { type: "text", text: "I'll look." },
    ToolCallPart.make({ id: "toolu_1", name: "shell", input: { command: "ls" } }),
    ToolCallPart.make({ id: "toolu_2", name: "read", input: { path: "a" } }),
  ]),
  Message.tool({ id: "toolu_1", name: "shell", result: "a\nb\n" + "x ".repeat(40_000) }),
  Message.tool({ id: "toolu_2", name: "read", result: { error: "ENOENT" }, resultType: "error" }),
  Message.assistant([
    { type: "reasoning", text: "", providerMetadata: { anthropic: { redactedData: "REDACTED" } } },
    { type: "text", text: "Done listing." },
  ]),
  Message.user([{ type: "text", text: "<conversation-checkpoint>\n<summary>S</summary>\n</conversation-checkpoint>" }]),
  Message.user([
    { type: "text", text: '<skill_content name="orchestrator">BODY</skill_content>' },
    { type: "text", text: "What is in this screenshot?" },
    { type: "media", mediaType: "image/png", data: png },
  ]),
]
const request = (messages = conversation, model = opus, session?: string) =>
  LLM.request({
    model,
    http: session === undefined ? undefined : { headers: { "x-opencode-session": session } },
    system: [
      { type: "text", text: "You are an AI agent running in OpenCode." },
      { type: "text", text: "# Your Model" },
    ],
    tools,
    messages,
    providerOptions: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
  })

const run = <A>(effect: Effect.Effect<A, unknown, LLMClient.Service>) =>
  effect.pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))))
const events = (input: ReturnType<typeof request>) =>
  run(
    LLMClient.stream(input).pipe(
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    ),
  )

// What the API sees once it merges same-role turns; cache breakpoints are Claude Code's to place.
const normalize = (messages: ReadonlyArray<any>) =>
  (JSON.parse(JSON.stringify(messages)) as any[])
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: (typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content).map(
        ({ cache_control: _, ...block }: any) =>
          block.type === "tool_result" && Array.isArray(block.content)
            ? { ...block, content: block.content.map(({ cache_control: _, ...item }: any) => item) }
            : block,
      ),
    }))
    .reduce<any[]>((merged, message) => {
      const previous = merged.at(-1)
      if (previous?.role === message.role) previous.content.push(...message.content)
      else merged.push(message)
      return merged
    }, [])
// Claude Code's own environment, model and date context: older models get it as leading reminders.
const withoutReminders = (messages: any[]) =>
  messages.map((message, index) =>
    index === 0
      ? { ...message, content: message.content.filter((block: any) => !block.text?.startsWith("<system-reminder>\n")) }
      : message,
  )
const upstream = () => recorded.filter((entry) => entry.path.startsWith("/v1/messages"))
const leftovers = () => {
  const projects = path.join(config, "projects", ClaudeCode.projectKey(directory))
  return existsSync(projects) ? readdirSync(projects) : []
}

describe("Claude Code route", () => {
  it.live(
    "sends OpenCode's exact conversation, tools, and system prompt through Claude Code",
    () =>
      Effect.gen(function* () {
        const input = request()
        const expected = (yield* compileRequest(input)).body as any
        yield* events(input)
        expect(upstream()).toHaveLength(1)
        const body = upstream()[0].body
        expect(withoutReminders(normalize(body.messages))).toEqual(normalize(expected.messages))
        // Claude Code orders tools by name; the definitions themselves pass through verbatim, beside the advisor the
        // login chose, which Claude Code adds itself.
        const definitions = (tools: any[]) =>
          tools.map(({ cache_control: _, ...tool }) => tool).sort((a, b) => a.name.localeCompare(b.name))
        expect(definitions(body.tools.filter((tool: any) => tool.name !== "advisor"))).toEqual(
          definitions(expected.tools),
        )
        expect(body.tools).toContainEqual(
          expect.objectContaining({ type: "advisor_20260301", name: "advisor", model: "claude-opus-5-5" }),
        )
        const system = body.system.map((block: any) => block.text).join("\n")
        expect(system).toContain("You are an AI agent running in OpenCode.\n\n# Your Model")
        expect(JSON.stringify(body)).not.toContain("AMBIENT")
        expect(JSON.stringify(body)).not.toContain("Explanatory")
        expect(body.model).toBe("claude-opus-5-5")
        expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" })
        expect(body.output_config).toEqual({ effort: "high" })
        expect(leftovers()).toEqual([])
      }),
    60_000,
  )

  it.live(
    "streams one model response and leaves tool execution to OpenCode",
    () =>
      Effect.gen(function* () {
        replies.push(sse(toolReply))
        const output = yield* events(request())
        expect(upstream()).toHaveLength(1)
        expect(output.filter((event) => event.type === "tool-call")).toMatchObject([
          { type: "tool-call", id: "toolu_new", name: "shell", input: { command: "ls" } },
          { type: "tool-call", id: "toolu_second", name: "read", input: { path: "a" } },
        ])
        expect(output.at(-1)).toMatchObject({ type: "finish", reason: { normalized: "tool-calls" } })
      }),
    60_000,
  )

  it.live(
    "continues from a tool result with its image intact",
    () =>
      Effect.gen(function* () {
        const messages = [
          Message.user("Take a screenshot."),
          Message.assistant([ToolCallPart.make({ id: "toolu_s", name: "shell", input: { command: "shot" } })]),
          Message.tool(
            ToolResultPart.make({
              id: "toolu_s",
              name: "shell",
              result: [
                { type: "text", text: "shot" },
                { type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png" },
              ],
              resultType: "content",
            }),
          ),
        ]
        const input = request(messages)
        const expected = (yield* compileRequest(input)).body as any
        yield* events(input)
        expect(normalize(upstream()[0].body.messages)).toEqual(normalize(expected.messages))
      }),
    60_000,
  )

  it.live(
    "keeps Claude Code's per-turn context in one stable position across steps",
    () =>
      Effect.gen(function* () {
        const first = [Message.user("alpha")]
        yield* events(request(first))
        const second = [...first, Message.assistant([{ type: "text", text: "Reply" }]), Message.user("beta")]
        yield* events(request(second))
        const [before, after] = upstream().map((entry) => entry.body.messages)
        // The first request ends at Claude Code's context message, where its breakpoint sits; the next one must
        // extend exactly that prefix instead of moving the context after the newest message.
        const text = (messages: any[]) =>
          messages.map((message) => ({
            role: message.role,
            text: (typeof message.content === "string"
              ? [message.content]
              : message.content.map((block: any) => block.text)
            ).join(""),
            effort: message.output_config?.effort,
          }))
        expect(text(after.slice(0, before.length))).toEqual(text(before))
        expect(text(after.slice(before.length))).toEqual([
          { role: "assistant", text: "Reply", effort: undefined },
          { role: "user", text: "beta", effort: undefined },
        ])
        expect(after.at(-1).content.at(-1).cache_control).toEqual({ type: "ephemeral" })
      }),
    60_000,
  )

  it.live(
    "keeps one Claude Code session identity per OpenCode Session and login",
    () =>
      Effect.gen(function* () {
        const inSession = (session: string, model = opus) => request([Message.user("hi")], model, session)
        yield* events(inSession("ses_a"))
        yield* events(inSession("ses_a"))
        yield* events(inSession("ses_b"))
        yield* Effect.all([events(inSession("ses_c")), events(inSession("ses_c"))], { concurrency: 2 })
        const other = ClaudeCode.model("claude-opus-5-5", { ...settings, configDirectory: path.join(root, "second") })
        mkdirSync(path.join(root, "second"), { recursive: true })
        writeFileSync(
          path.join(root, "second", ".claude.json"),
          JSON.stringify({ oauthAccount: { organizationUuid: "org", accountUuid: "acct" } }),
        )
        yield* events(inSession("ses_a", other))
        const [a1, a2, b, c1, c2, second] = upstream().map((entry) => entry.session)
        expect(a1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        expect(a2).toBe(a1)
        expect(new Set([a1, b, c1, c2, second]).size).toBe(5)
        expect(leftovers()).toEqual([])
      }),
    120_000,
  )

  it.live(
    "governs each assistant turn with the effort OpenCode recorded for it",
    () =>
      Effect.gen(function* () {
        const input = LLM.request({
          model: ClaudeCode.model("claude-opus-5-5", settings),
          system: "You are an AI agent running in OpenCode.",
          messages: [
            Message.user("first"),
            Message.assistant([{ type: "text", text: "one" }]),
            Message.effort({ effort: "max", previous: "high" }),
            Message.user("second"),
            Message.assistant([{ type: "text", text: "two" }]),
            Message.user("third"),
          ],
          providerOptions: { thinking: { type: "adaptive" }, effort: "max" },
        })
        const expected = (yield* compileRequest(input)).body as any
        yield* events(input)
        const body = upstream()[0].body
        // OpenCode freezes the top-level effort at the start and marks the switch where it happened; Claude Code
        // marks each assistant turn with the effort it ran at and sends the current effort at the top level.
        // Both must govern every turn with the same effort.
        const governing = (messages: any[], initial: string) =>
          messages.reduce(
            (state, message) =>
              message.role === "system" && message.output_config
                ? { ...state, effort: message.output_config.effort }
                : message.role === "assistant"
                  ? { ...state, turns: [...state.turns, state.effort] }
                  : state,
            { effort: initial, turns: [] as string[] },
          )
        const sent = governing(body.messages, body.output_config.effort)
        const compiled = governing(expected.messages, expected.output_config.effort)
        expect(sent.turns).toEqual(["high", "max"])
        expect(compiled.turns).toEqual(sent.turns)
        expect(body.output_config.effort).toBe(compiled.effort)
      }),
    60_000,
  )

  it.live(
    "stops Claude Code and releases the step when the consumer stops early",
    () =>
      Effect.gen(function* () {
        replies.push(hanging(3))
        const first = yield* run(
          LLMClient.stream(request([Message.user("hi")], opus, "ses_interrupted")).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        )
        expect(Array.from(first).map((event) => event.type)).toEqual(["step-start"])
        expect(children()).toEqual([])
        expect(leftovers()).toEqual([])
        yield* events(request([Message.user("hi")], opus, "ses_interrupted"))
        const [interrupted, next] = upstream().map((entry) => entry.session)
        expect(next).toBe(interrupted)
      }),
    60_000,
  )

  it.live(
    "stops Claude Code promptly when interrupted while waiting for the next event",
    () =>
      Effect.gen(function* () {
        replies.push(hanging(1))
        const fiber = yield* events(request([Message.user("hi")], opus, "ses_waiting")).pipe(Effect.forkChild)
        while (upstream().length === 0) yield* Effect.sleep("20 millis")
        yield* Effect.sleep("300 millis")
        const started = Date.now()
        yield* Fiber.interrupt(fiber)
        expect(Date.now() - started).toBeLessThan(5_000)
        expect(children()).toEqual([])
        expect(leftovers()).toEqual([])
      }),
    60_000,
  )

  it.live(
    "sends no thinking and the API's default effort when the request sets neither",
    () =>
      Effect.gen(function* () {
        yield* events(LLM.request({ model: opus, system: "You are concise.", prompt: "hi" }))
        const body = upstream()[0].body
        expect(body.thinking === undefined || body.thinking.type === "disabled").toBe(true)
        expect(body.output_config?.effort ?? "high").toBe("high")
      }),
    60_000,
  )

  it.live(
    "keeps Claude Code settings inherited by the server out of the request",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const saved = { effort: process.env.CLAUDE_CODE_EFFORT_LEVEL, body: process.env.CLAUDE_CODE_EXTRA_BODY }
          process.env.CLAUDE_CODE_EFFORT_LEVEL = "low"
          process.env.CLAUDE_CODE_EXTRA_BODY = JSON.stringify({ temperature: 0.3 })
          return saved
        }),
        () =>
          Effect.gen(function* () {
            // The inherited environment is read when the model is selected.
            yield* events(request([Message.user("hi")], ClaudeCode.model("claude-opus-5-5", settings)))
            const body = upstream()[0].body
            expect(body.output_config).toEqual({ effort: "high" })
            expect(body.temperature).toBeUndefined()
          }),
        (saved) =>
          Effect.sync(() => {
            if (saved.effort === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL
            else process.env.CLAUDE_CODE_EFFORT_LEVEL = saved.effort
            if (saved.body === undefined) delete process.env.CLAUDE_CODE_EXTRA_BODY
            else process.env.CLAUDE_CODE_EXTRA_BODY = saved.body
          }),
      ),
    60_000,
  )

  it.live(
    "refuses requests Claude Code would alter",
    () =>
      Effect.gen(function* () {
        const refused = (input: ReturnType<typeof request>) =>
          events(input).pipe(
            Effect.flip,
            Effect.map((error: any) => [error.reason._tag, error.reason.message]),
          )
        const overlay = ClaudeCode.model("claude-opus-5-5", {
          ...settings,
          body: { service_tier: "priority", extra: 1 },
        })
        expect(yield* refused(request([Message.user("hi")], overlay))).toEqual([
          "InvalidRequest",
          expect.stringContaining("extra"),
        ])
        expect(
          yield* refused(request([Message.user("hi"), Message.assistant([{ type: "text", text: "Prefill" }])])),
        ).toEqual(["InvalidRequest", expect.stringContaining("ends with a user message")])
        expect(upstream()).toHaveLength(0)
      }),
    60_000,
  )

  it.live(
    "classifies API failures like the HTTP route",
    () =>
      Effect.gen(function* () {
        const cases = [
          [failure(429, "rate_limit_error", "slow down"), "RateLimit"],
          [failure(529, "overloaded_error", "overloaded"), "ProviderInternal"],
          [failure(401, "authentication_error", "bad login"), "Authentication"],
          [failure(400, "invalid_request_error", "prompt is too long: 2 > 1 maximum"), "InvalidRequest"],
        ] as const
        const reasons = yield* Effect.forEach(cases, ([response]) => {
          replies.push(response)
          return events(request([Message.user("hi")])).pipe(
            Effect.flip,
            Effect.map((error: any) => error.reason),
          )
        })
        expect(reasons.map((reason: any) => reason._tag)).toEqual(cases.map(([, tag]) => tag))
        expect(reasons[3].classification).toBe("context-overflow")
        expect(upstream()).toHaveLength(cases.length)
      }),
    120_000,
  )

  it.live(
    "refuses to run under a different Claude Code login",
    () =>
      Effect.gen(function* () {
        const error: any = yield* events(
          request([Message.user("hi")], ClaudeCode.model("claude-opus-5-5", { ...settings, account: "org/other" })),
        ).pipe(Effect.flip)
        expect(error.reason._tag).toBe("Authentication")
        expect(upstream()).toHaveLength(0)
      }),
    60_000,
  )

  it.live(
    "refuses request options Claude Code cannot send",
    () =>
      Effect.gen(function* () {
        const error: any = yield* events(
          LLM.request({ model: opus, prompt: "hi", generation: { temperature: 0.2 } }),
        ).pipe(Effect.flip)
        expect(error.reason._tag).toBe("InvalidRequest")
        expect(error.reason.message).toContain("temperature")
        expect(upstream()).toHaveLength(0)
      }),
    60_000,
  )
})

describe("Claude Code web search", () => {
  const webSearch = ToolDefinition.make({
    name: "web_search",
    description: "Search the web with the provider's own web search.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    native: { openai: { type: "web_search", external_web_access: true } },
  })
  const searchRequest = (messages: ReadonlyArray<Message>) =>
    LLM.request({ model: opus, system: [{ type: "text", text: "Search." }], tools: [...tools, webSearch], messages })
  const searchCall = [
    start,
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_search", name: "WebSearch", input: {} },
    },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"kernel"}' } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
    { type: "message_stop" },
  ]
  // Claude Code's own request running the server search tool.
  const serverSearch = [
    start,
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
    },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"kernel"}' } },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [{ type: "web_search_result", title: "Kernel", url: "https://kernel.org", encrypted_content: "E" }],
      },
    },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Linux 7.2 is current." } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]

  it.live(
    "runs WebSearch inside Claude Code and returns it as a provider-run search",
    () =>
      Effect.gen(function* () {
        replies.push(sse(searchCall), sse(serverSearch))
        const output = yield* events(searchRequest([Message.user("What is the current kernel?")]))
        const [main, side] = upstream()
        expect(upstream()).toHaveLength(2)
        // Claude Code offers its own WebSearch in place of OpenCode's placeholder definition.
        expect(main.body.tools.map((tool: any) => tool.name).sort()).toEqual(["WebSearch", "advisor", "read", "shell"])
        expect(side.body.tools).toEqual([expect.objectContaining({ type: "web_search_20250305", name: "web_search" })])
        const call = output.find((event: any) => event.type === "tool-call") as any
        expect(call).toMatchObject({ id: "toolu_search", name: "web_search", input: { query: "kernel" } })
        expect(call.providerExecuted).toBe(true)
        const result = output.find((event: any) => event.type === "tool-result") as any
        expect(result).toMatchObject({ id: "toolu_search", name: "web_search", providerExecuted: true })
        expect(result.result.value.results).toEqual([{ title: "Kernel", url: "https://kernel.org" }])
        expect(result.result.value.text).toContain("https://kernel.org")
        expect(result.result.value.text).toContain("Linux 7.2 is current.")
        expect(output.find((event: any) => event.type === "step-finish")).toMatchObject({
          reason: { normalized: "tool-calls" },
        })
        expect(leftovers()).toEqual([])
        expect(children()).toEqual([])
      }),
    60_000,
  )

  it.live(
    "replays a provider-run search as Claude Code's own call and result",
    () =>
      Effect.gen(function* () {
        const content = { text: "Web search results for query: kernel", results: [] }
        yield* events(
          searchRequest([
            Message.user("What is the current kernel?"),
            Message.assistant([
              ToolCallPart.make({
                id: "toolu_search",
                name: "web_search",
                input: { query: "kernel" },
                providerExecuted: true,
              }),
              ToolResultPart.make({
                id: "toolu_search",
                name: "web_search",
                result: content,
                providerExecuted: true,
                providerMetadata: { anthropic: { blockType: "web_search_tool_result", result: content } },
              }),
            ]),
          ]),
        )
        expect(upstream()).toHaveLength(1)
        expect(withoutReminders(normalize(upstream()[0].body.messages))).toEqual([
          { role: "user", content: [{ type: "text", text: "What is the current kernel?" }] },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_search", name: "WebSearch", input: { query: "kernel" } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_search", content: content.text }],
          },
        ])
        expect(leftovers()).toEqual([])
      }),
    60_000,
  )
})

describe("Claude Code prompt cache", () => {
  // Its own project, since it becomes a git repository midway.
  const project = path.join(root, "evolving")
  mkdirSync(project, { recursive: true })
  const model = ClaudeCode.model("claude-opus-5-5", { ...settings, directory: project })
  const step = (history: ReadonlyArray<Message>) => events(request(history as Message[], model, "ses_cache"))
  const system = (body: any) => ({ system: body.system.map((block: any) => block.text), tools: body.tools })
  // Every message as sent, including Claude Code's system-role context; only breakpoint placement is Claude Code's.
  const sent = (body: any) =>
    (JSON.parse(JSON.stringify(body.messages)) as any[]).map((message) => ({
      role: message.role,
      content: (typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content).map(
        ({ cache_control: _, ...block }: any) => block,
      ),
    }))
  const prefixOf = (earlier: any, later: any) => {
    expect(system(later)).toEqual(system(earlier))
    expect(sent(later).slice(0, sent(earlier).length)).toEqual(sent(earlier))
  }
  const context = (body: any, heading: string) =>
    sent(body).flatMap((message, index) =>
      message.role === "system" &&
      message.content.some((block: any) => block.text?.replace(/^<system-reminder>\n/, "").startsWith(heading))
        ? [index]
        : [],
    )

  it.live(
    "repeats each step's prefix, keeping an environment change where Claude Code announced it",
    () =>
      Effect.gen(function* () {
        const history: Message[] = [Message.user("Look at the repo.")]
        replies.push(sse(toolReply))
        yield* step(history)
        history.push(
          Message.assistant([
            ToolCallPart.make({ id: "toolu_new", name: "shell", input: { command: "ls" } }),
            ToolCallPart.make({ id: "toolu_second", name: "read", input: { path: "a" } }),
          ]),
          Message.tool({ id: "toolu_new", name: "shell", result: "a\nb" }),
          Message.tool({ id: "toolu_second", name: "read", result: "contents" }),
        )
        yield* step(history)
        history.push(Message.assistant([{ type: "text", text: "Read both." }]), Message.user("Summarize."))
        yield* step(history)
        Bun.spawnSync(["git", "init", "-q", project])
        history.push(Message.assistant([{ type: "text", text: "Summary." }]), Message.user("Continue."))
        yield* step(history)
        history.push(Message.assistant([{ type: "text", text: "Continued." }]), Message.user("Again."))
        yield* step(history)

        const bodies = upstream().map((entry) => entry.body)
        expect(bodies).toHaveLength(5)
        bodies.slice(1).forEach((body, index) => prefixOf(bodies[index], body))
        // The initial context stays where the first step placed it; the change is announced after the fourth step's
        // newest message and kept there rather than rewriting the start.
        expect(bodies.map((body) => context(body, "# Environment\n"))).toEqual([[1], [1], [1], [1], [1]])
        expect(context(bodies[3], "# Environment update")).toEqual([sent(bodies[3]).length - 1])
        expect(context(bodies[4], "# Environment update")).toEqual(context(bodies[3], "# Environment update"))

        // Reverting to before the change drops what was announced after it: the reverted history repeats exactly, and
        // the still-changed environment is announced again after its newest message.
        yield* step(history.slice(0, 6))
        const reverted = upstream().at(-1)!.body
        prefixOf(bodies[2], reverted)
        expect(context(reverted, "# Environment update")).toEqual([sent(bodies[2]).length])
        expect(leftovers()).toEqual([])
      }),
    120_000,
  )

  it.live(
    "keeps a long history's prefix when it arrives at a model the process has no context for",
    () =>
      Effect.gen(function* () {
        // As after switching models mid-session: Claude Code announces its context after the newest message.
        const switched = ClaudeCode.model("claude-sonnet-5", { ...settings, directory: project })
        const history: Message[] = [
          Message.user("First."),
          Message.assistant([{ type: "text", text: "One." }]),
          Message.user("Second."),
          Message.assistant([{ type: "text", text: "Two." }]),
          Message.user("Third."),
        ]
        yield* events(request(history, switched, "ses_switch"))
        history.push(Message.assistant([{ type: "text", text: "Three." }]), Message.user("Fourth."))
        yield* events(request(history, switched, "ses_switch"))
        const [first, second] = upstream().map((entry) => entry.body)
        expect(context(first, "# Environment\n")).toEqual([5])
        prefixOf(first, second)
      }),
    120_000,
  )
})

describe("Claude Code advisor", () => {
  const redacted = { type: "advisor_redacted_result", encrypted_content: "ENCRYPTED" }
  const advised = [
    start,
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "server_tool_use", id: "srvtoolu_advice", name: "advisor", input: {} },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "advisor_tool_result", tool_use_id: "srvtoolu_advice", content: redacted },
    },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Advised." } },
    { type: "content_block_stop", index: 2 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: {
        input_tokens: 12,
        cache_read_input_tokens: 180,
        output_tokens: 8,
        iterations: [
          { type: "message", input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 3 },
          { type: "advisor_message", model: "claude-opus-5-5", input_tokens: 100, output_tokens: 700 },
          { type: "message", input_tokens: 2, cache_read_input_tokens: 90, output_tokens: 5 },
        ],
      },
    },
    { type: "message_stop" },
  ]

  it.live(
    "streams the advisor as a provider-run call and result, billing only the session model's iterations",
    () =>
      Effect.gen(function* () {
        replies.push(sse(advised))
        const output = yield* events(request([Message.user("Plan the fix.")]))
        expect(output.find((event: any) => event.type === "tool-call")).toMatchObject({
          id: "srvtoolu_advice",
          name: "advisor",
          providerExecuted: true,
        })
        expect(output.find((event: any) => event.type === "tool-result")).toMatchObject({
          id: "srvtoolu_advice",
          name: "advisor",
          providerExecuted: true,
          result: { type: "json", value: redacted },
        })
        const finish = output.find((event: any) => event.type === "finish") as any
        expect(finish.reason.normalized).toBe("stop")
        expect(finish.usage).toMatchObject({
          nonCachedInputTokens: 12,
          cacheReadInputTokens: 180,
          outputTokens: 8,
          contextTokens: 92,
        })
      }),
    60_000,
  )

  it.live(
    "replays an advisor call and its opaque result as the API returned them",
    () =>
      Effect.gen(function* () {
        yield* events(
          request([
            Message.user("Plan the fix."),
            Message.assistant([
              ToolCallPart.make({ id: "srvtoolu_advice", name: "advisor", input: {}, providerExecuted: true }),
              ToolResultPart.make({
                id: "srvtoolu_advice",
                name: "advisor",
                result: redacted,
                providerExecuted: true,
                providerMetadata: { anthropic: { blockType: "advisor_tool_result", result: redacted } },
              }),
              { type: "text", text: "Advised." },
            ]),
            Message.user("Go on."),
          ]),
        )
        expect(upstream()).toHaveLength(1)
        expect(withoutReminders(normalize(upstream()[0].body.messages))).toEqual([
          { role: "user", content: [{ type: "text", text: "Plan the fix." }] },
          {
            role: "assistant",
            content: [
              { type: "server_tool_use", id: "srvtoolu_advice", name: "advisor", input: {} },
              { type: "advisor_tool_result", tool_use_id: "srvtoolu_advice", content: redacted },
              { type: "text", text: "Advised." },
            ],
          },
          { role: "user", content: [{ type: "text", text: "Go on." }] },
        ])
      }),
    60_000,
  )
})

describe("Claude Code memory", () => {
  // A worktree shares the auto memory of its main checkout, which the route receives as `project`.
  const worktree = path.join(root, "worktree")
  const main = path.join(root, "main")
  mkdirSync(worktree, { recursive: true })
  const store = path.join(config, "projects", ClaudeCode.projectKey(main), "memory")
  mkdirSync(store, { recursive: true })
  const model = ClaudeCode.model("claude-opus-5-5", { ...settings, directory: worktree, project: main })
  const memory = (body: any) => {
    const system = body.system.map((block: any) => block.text).join("\n")
    const start = system.indexOf("# Memory\n")
    return start === -1 ? undefined : system.slice(start)
  }

  it.live(
    "starts each conversation with the project's memory index and keeps it for the conversation",
    () =>
      Effect.gen(function* () {
        writeFileSync(path.join(store, "MEMORY.md"), "- [First](first.md) — the first fact\n")
        const history: Message[] = [Message.user("Look.")]
        yield* events(request(history, model, "ses_memory"))
        writeFileSync(
          path.join(store, "MEMORY.md"),
          "- [First](first.md) — the first fact\n- [Second](second.md) — saved since\n",
        )
        history.push(Message.assistant([{ type: "text", text: "Looked." }]), Message.user("Again."))
        yield* events(request(history, model, "ses_memory"))
        yield* events(request([Message.user("New.")], model, "ses_memory_next"))

        const [first, second, next] = upstream().map((entry) => entry.body)
        expect(memory(first)).toContain(store)
        expect(memory(first)).toContain("the first fact")
        expect(memory(first)).not.toContain("saved since")
        // Rewriting the system prompt would re-cache the whole conversation; the saved memory waits for the next one.
        expect(second.system).toEqual(first.system)
        expect(memory(next)).toContain("saved since")
      }),
    120_000,
  )

  it.live(
    "follows the login turning auto memory off",
    () =>
      Effect.gen(function* () {
        writeFileSync(path.join(config, "settings.json"), JSON.stringify({ ...ambient, autoMemoryEnabled: false }))
        yield* events(request([Message.user("Look.")], model, "ses_memory_off")).pipe(
          Effect.ensuring(
            Effect.sync(() => writeFileSync(path.join(config, "settings.json"), JSON.stringify(ambient))),
          ),
        )
        expect(memory(upstream()[0].body)).toBeUndefined()
      }),
    60_000,
  )
})
