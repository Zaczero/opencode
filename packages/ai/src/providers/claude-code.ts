import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { Effect, Option, Schema, Stream } from "effect"
import type {
  McpSdkServerConfigWithInstance,
  ModelInfo,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import type { ProviderPackage } from "../provider-package.js"
import { AnthropicMessages } from "../protocols/anthropic-messages.js"
import { ProviderShared } from "../protocols/shared.js"
import { Auth } from "../route/auth.js"
import { Route } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { httpFailure } from "../route/executor.js"
import { HttpTransport, type Transport } from "../route/transport/index.js"
import {
  AIError,
  AuthenticationError,
  InvalidProviderOutputError,
  InvalidRequestError,
  ProviderConfigurationError,
  ProviderID,
  TransportError,
} from "../schema/index.js"

export const id = ProviderID.make("claude-code")

/**
 * `account` is the non-secret identity of the Claude Code login (see `account()`), `directory` the Location the
 * session runs in, and `executable` the Claude Code binary. `project` is the checkout whose Claude Code auto memory
 * the session shares, the main one for a worktree; it defaults to `directory`. `configDirectory` selects the
 * login's config directory instead of the inherited `CLAUDE_CONFIG_DIR`; `account` must name that login. `env`
 * overlays the child environment after inherited provider and Claude Code settings are scrubbed.
 */
export type Settings = ProviderPackage.Settings &
  AnthropicMessages.ProviderOptionsInput & {
    readonly account: string
    readonly directory: string
    readonly executable: string
    readonly project?: string
    readonly configDirectory?: string
    readonly env?: Readonly<Record<string, string>>
  }

type Body = AnthropicMessages.AnthropicMessagesBody
type Message = Body["messages"][number]
type Attachment = { readonly type: string } & Record<string, unknown>
type Environment = Readonly<Record<string, string | undefined>>
type Connection = {
  readonly account: string
  readonly directory: string
  readonly project: string
  readonly executable: string
  readonly env: Environment
}

const decodeLogin = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ oauthAccount: Schema.Struct({ organizationUuid: Schema.String, accountUuid: Schema.String }) }),
  ),
)

/** Reads the Claude Code login from the config file the CLI itself resolves; tokens stay with Claude Code. */
export const account = async (env: Environment = process.env) => {
  const file = env.CLAUDE_CONFIG_DIR
    ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json")
    : path.join(env.HOME ?? homedir(), ".claude.json")
  const login = Option.getOrUndefined(decodeLogin(await readFile(file, "utf8").catch(() => "")))?.oauthAccount
  return login && `${login.organizationUuid}/${login.accountUuid}`
}

const decodeSettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      advisorModel: Schema.optional(Schema.String),
      autoMemoryEnabled: Schema.optional(Schema.Boolean),
      autoMemoryDirectory: Schema.optional(Schema.String),
    }),
  ),
)

/** The login's own choices the route follows, from the user settings Claude Code runs without here. */
const loginSettings = async (root: string) =>
  Option.getOrElse(decodeSettings(await readFile(path.join(root, "settings.json"), "utf8").catch(() => "")), () => ({
    advisorModel: undefined,
    autoMemoryEnabled: undefined,
    autoMemoryDirectory: undefined,
  }))

/**
 * The models the installed Claude Code offers in its model picker: versionless aliases such as `opus`, which follow
 * the newest model of their family, and explicit versions, each with the concrete model it resolves to and its
 * display name, read without a model call. Claude Code's own context-window suffix (`opus[1m]`) is not part of
 * the model's identity. A Claude Code that does not answer within `timeout` milliseconds yields none.
 */
export const models = async (executable: string, env: Environment = process.env, timeout = 30_000) => {
  const { query } = await import("@anthropic-ai/claude-agent-sdk")
  const idle = Promise.withResolvers<void>()
  const run = query({
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      await idle.promise
    })(),
    options: {
      pathToClaudeCodeExecutable: executable,
      settingSources: [],
      tools: [],
      persistSession: false,
      env: childEnv(env),
    },
  })
  const expiry = Promise.withResolvers<ReadonlyArray<ModelInfo>>()
  const timer = setTimeout(() => expiry.resolve([]), timeout)
  const offered = await Promise.race([run.supportedModels().catch(() => []), expiry.promise]).finally(() => {
    clearTimeout(timer)
    idle.resolve()
    run.close()
  })
  const plain = (id: string) => id.replace(/\[[^\]]*\]$/, "")
  // `default` only points at another row.
  const rows = offered.flatMap((row) =>
    row.value === "default" || !row.resolvedModel
      ? []
      : [{ id: plain(row.value), model: plain(row.resolvedModel), name: row.displayName }],
  )
  return [...new Map(rows.map((row) => [row.id, row])).values()]
}

const route = (connection: Connection) =>
  Route.make({
    id: "claude-code",
    provider: id,
    providerMetadataKey: "anthropic",
    protocol: AnthropicMessages.protocol,
    endpoint: Endpoint.path("/v1/messages", { baseURL: "claude-code://local" }),
    auth: Auth.none,
    transport: transport(connection),
  })

export const model: ProviderPackage.Definition<Settings, AnthropicMessages.ProviderOptionsInput>["model"] = (
  modelID,
  { account, directory, executable, project, configDirectory, env, baseURL: _, headers, body, ...providerOptions },
) => {
  if (!account || !directory || !executable)
    throw new ProviderConfigurationError({
      provider: id,
      message: "Claude Code requires account, directory, and executable settings",
    })
  return route({
    account,
    directory,
    project: project ?? directory,
    executable,
    env: {
      ...childEnv(process.env),
      ...env,
      ...(configDirectory === undefined ? {} : { CLAUDE_CONFIG_DIR: configDirectory }),
    },
  })
    .with({
      headers: headers === undefined ? undefined : { ...headers },
      http: body === undefined ? undefined : { body: { ...body } },
      providerOptions,
    })
    .model<AnthropicMessages.ProviderOptionsInput>({
      id: modelID,
      // A Claude Code transcript has no API system-role entries. Effort markers remain: they are folded into
      // per-entry effort, which Claude Code renders as its own per-turn effort markers.
      compatibility: { supportsNativeSystemUpdates: false, supportsThinkingBlockBinding: false },
    })
}

// OpenCode's name for search the provider runs, and Claude Code's built-in tool that runs it.
const SEARCH = "web_search"
const CLAUDE_SEARCH = "WebSearch"

// Each switch removes Claude Code behavior that would change the request OpenCode prepared: its own
// compaction, tool deferral and description truncation, retries and non-streaming fallback (a retry after
// output restarts the stream), CLAUDE.md loading, auto memory with its recall, extraction, and dreaming (the
// route renders the memory index itself, see `memory`), account connectors, and per-account reminders. The
// advisor is enabled explicitly, since Claude Code leaves it off here despite the login's rollout flag; it still
// needs the login's `advisorModel`.
const CHILD_ENV = {
  CLAUDE_AGENT_SDK_CLIENT_APP: "opencode",
  CLAUDE_AGENT_SDK_MCP_NO_PREFIX: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
  CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL: "1",
  CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: String(Number.MAX_SAFE_INTEGER),
  CLAUDE_CODE_MAX_RETRIES: "0",
  CLAUDE_CODE_SILENT_TURN_REMINDER: "0",
  CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_COMPACT: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  ENABLE_TOOL_SEARCH: "false",
}

// Claude Code reads request-shaping and credential overrides from many inherited variables (effort, extra
// body fields, thinking budgets, caching, API routing, tokens); only the login's config directory passes.
const childEnv = (env: Environment) => ({
  ...Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        name === "CLAUDE_CONFIG_DIR" ||
        !(
          name.startsWith("ANTHROPIC_") ||
          name.startsWith("CLAUDE") ||
          name.startsWith("DISABLE_PROMPT_CACHING") ||
          name === "MAX_THINKING_TOKENS"
        ),
    ),
  ),
  ...CHILD_ENV,
})

const transport = (connection: Connection): Transport<Body, Body, string> => ({
  id: "claude-code",
  prepare: (input) =>
    HttpTransport.jsonRequestParts(input).pipe(
      Effect.flatMap((parts) => admit(replaySearches(parts.jsonBody as Body))),
    ),
  execute: (body, request) =>
    Effect.gen(function* () {
      const live = yield* Effect.promise(() => account(connection.env))
      if (live !== connection.account)
        return yield* new AIError({
          reason: new AuthenticationError({
            message: live
              ? "Claude Code is logged in to a different account than this model was resolved for; reload OpenCode"
              : "Claude Code is not logged in; run `claude /login`",
          }),
        })
      const { query } = yield* Effect.promise(() => import("@anthropic-ai/claude-agent-sdk"))
      const root = connection.env.CLAUDE_CONFIG_DIR ?? path.join(connection.env.HOME ?? homedir(), ".claude")
      const settings = yield* Effect.promise(() => loginSettings(root))
      // Released in reverse: the process exits, then its transcript is harvested and removed, then the
      // session identity is free for the Session's next step.
      const sessionId = yield* Effect.acquireRelease(
        Effect.sync(() => claim(connection, request.http?.headers?.["x-opencode-session"])),
        (sessionId) => Effect.sync(() => active.delete(sessionId)),
      )
      const seedKey = ProviderShared.encodeJson([
        connection.env.CLAUDE_CONFIG_DIR,
        connection.account,
        connection.executable,
        connection.directory,
        body.model,
      ])
      const conversation = conversationOf(body)
      // A conversation is its Session's history from one first turn; a title request or a compacted history in the
      // same Session starts from another and keeps its own attachments.
      const session = request.http?.headers?.["x-opencode-session"]
      const contextFile =
        session === undefined
          ? undefined
          : path.join(
              root,
              "opencode",
              `${createHash("sha256")
                .update(ProviderShared.encodeJson([seedKey, session, conversation.prefixes[1]]))
                .digest("hex")}.json`,
            )
      // Read on every step from beside the login, so a restart rebuilds the same transcript instead of re-caching it.
      const stored = contextFile ? yield* Effect.promise(() => loadContext(contextFile)) : undefined
      const context = {
        initial: stored?.initial ?? seeds.get(seedKey) ?? [],
        anchored: (stored?.anchored ?? []).filter(
          (anchored) =>
            anchored.after <= conversation.turns.length && conversation.prefixes[anchored.after] === anchored.prefix,
        ),
        memory: stored ? stored.memory : yield* Effect.promise(() => memory(root, settings, connection)),
      }
      const entries = transcript(body, conversation, connection.directory, sessionId, context)
      const file = path.join(root, "projects", projectKey(connection.directory), `${sessionId}.jsonl`)
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            mkdir(path.dirname(file), { recursive: true }).then(() =>
              writeFile(file, entries.lines.map((entry) => ProviderShared.encodeJson(entry)).join("\n") + "\n"),
            ),
          catch: (cause) => processFailure(cause, ""),
        }),
        () =>
          Effect.promise(() =>
            appended(file, entries.lines.length)
              .then((announced) =>
                record({ announced, seedKey, context, conversation, contextFile, fresh: stored === undefined }),
              )
              .finally(() => remove(file, sessionId)),
          ),
      )
      const child = { exited: Promise.resolve(), stderr: "" }
      const run = yield* Effect.acquireRelease(
        Effect.try({
          try: () => start(query, connection, body, sessionId, entries, child, context.memory, settings.advisorModel),
          catch: (cause) => processFailure(cause, ""),
        }),
        (run) =>
          Effect.promise(() => {
            run.close()
            return child.exited
          }),
      )
      return { frames: frames(run, child) }
    }),
})

// Top-level fields Claude Code can carry or owns itself (`metadata` identity and `cache_control` breakpoints);
// any other field, including a configured body overlay, would be dropped, so the request is refused instead.
const SENDABLE = new Set([
  "model",
  "system",
  "messages",
  "tools",
  "tool_choice",
  "stream",
  "max_tokens",
  "thinking",
  "output_config",
  "metadata",
  "cache_control",
])

const admit = (body: Body) => {
  const unsupported = [
    ...Object.entries(body).flatMap(([name, value]) =>
      SENDABLE.has(name) || value === undefined || value === null ? [] : [name],
    ),
    ...(body.output_config?.format ? ["output_config.format"] : []),
  ]
  const refusal =
    unsupported.length > 0
      ? `Claude Code cannot send ${unsupported.join(", ")}`
      : // `none` stays advisory: dropping the definitions would invalidate the whole cached prefix.
        body.tool_choice && body.tool_choice.type !== "auto" && body.tool_choice.type !== "none"
        ? "Claude Code cannot force a tool choice"
        : body.messages.some((message) => message.role === "system" && message.content.length > 0)
          ? "Claude Code cannot send native system updates"
          : body.messages.findLast((message) => message.role !== "system")?.role !== "user"
            ? "Claude Code needs a conversation that ends with a user message"
            : undefined
  if (refusal) return Effect.fail(new AIError({ reason: new InvalidRequestError({ message: refusal }) }))
  return Effect.succeed(body)
}

/**
 * Claude Code's WebSearch is its own tool call, answered in the next user entry; OpenCode records it as a
 * provider-run `web_search` call with its result in the same assistant message. Replay restores Claude Code's
 * form, so the transcript reads as Claude Code wrote it and a continuation ends with the search result.
 */
const replaySearches = (body: Body): Body => ({
  ...body,
  messages: body.messages.flatMap((message): Message[] => {
    if (message.role !== "assistant" || !message.content.some((block) => block.type === "web_search_tool_result"))
      return [message]
    return message.content.reduce<Array<{ role: "user" | "assistant"; content: Array<object> }>>((split, block) => {
      const answer = block.type === "web_search_tool_result"
      const role = answer ? "user" : "assistant"
      const converted = answer
        ? {
            type: "tool_result",
            tool_use_id: block.tool_use_id,
            content: searchText(block.content),
            ...(searchFailed(block.content) ? { is_error: true } : {}),
          }
        : block.type === "server_tool_use" && block.name === SEARCH
          ? { type: "tool_use", id: block.id, name: CLAUDE_SEARCH, input: block.input }
          : block
      const last = split.at(-1)
      if (last?.role === role) return [...split.slice(0, -1), { role, content: [...last.content, converted] }]
      return [...split, { role, content: [converted] }]
    }, []) as Message[]
  }),
})

const searchText = (content: unknown) =>
  ProviderShared.isRecord(content) && typeof content.text === "string"
    ? content.text
    : ProviderShared.encodeJson(content)
const searchFailed = (content: unknown) => ProviderShared.isRecord(content) && content.type === SEARCH_ERROR
const SEARCH_ERROR = "web_search_tool_result_error"

/**
 * Attachments Claude Code announces in its transcript: per-turn context (environment, model identity, date), the
 * advisor's availability, and whatever a later Claude Code adds. Without a prior copy it appends them after the
 * newest message with the only message cache breakpoint, so no rebuilt transcript would reuse the cached
 * conversation. A conversation therefore keeps the attachments it started with at its start, and every later
 * announcement where Claude Code made it, re-materialized there on every step as Claude Code's own transcript keeps
 * it; replacing the start instead would change the whole cached prefix. `seeds` holds the latest state announcements
 * (the per-turn context and the advisor's availability, not one-off notices) per login, executable, directory, and
 * model for new conversations.
 */
const seeds = new Map<string, readonly Attachment[]>()
const SEEDED = new Set(["environment", "model", "session_context", "date", "advisor_tool"])
const AttachmentValue = Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown),
])
const decodeEntry = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String, attachment: Schema.optional(AttachmentValue) })),
)

/**
 * One conversation's attachments and memory. An announced change is anchored after the turn it followed, with the
 * hash of the conversation up to there, so a revert or compaction that rewrites that span drops it. The memory
 * section is the one the conversation started with.
 */
const ConversationContext = Schema.Struct({
  initial: Schema.Array(AttachmentValue),
  anchored: Schema.Array(Schema.Struct({ after: Schema.Int, prefix: Schema.String, attachment: AttachmentValue })),
  memory: Schema.optional(Schema.String),
})
type ConversationContext = typeof ConversationContext.Type
const decodeContext = Schema.decodeUnknownOption(Schema.fromJsonString(ConversationContext))

const loadContext = async (file: string) =>
  Option.getOrUndefined(decodeContext(await readFile(file, "utf8").catch(() => "")))

const saveContext = (file: string, context: ConversationContext) =>
  mkdir(path.dirname(file), { recursive: true })
    .then(() => writeFile(file, ProviderShared.encodeJson(context)))
    .then(() => pruneContexts(path.dirname(file)))
    .catch(() => undefined)

// A conversation idle for a month has left the prompt cache long ago.
let pruned = false
const pruneContexts = async (directory: string) => {
  if (pruned) return
  pruned = true
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
  const files = await readdir(directory).catch(() => [])
  await Promise.all(
    files.map((name) =>
      stat(path.join(directory, name))
        .then((info) => (info.mtimeMs < cutoff ? rm(path.join(directory, name), { force: true }) : undefined))
        .catch(() => undefined),
    ),
  )
}

/** The attachments Claude Code appended to a step's transcript after the `written` entries OpenCode wrote. */
const appended = async (file: string, written: number) =>
  (
    await readFile(file, "utf8")
      .then((text) => text.split("\n").slice(written))
      .catch(() => [])
  ).flatMap((line) =>
    Option.match(decodeEntry(line), {
      onNone: () => [],
      onSome: (entry) =>
        entry.type === "attachment" && entry.attachment ? [entry.attachment] : [],
    }),
  )

/**
 * Records what Claude Code announced during a step: the latest values for new conversations, and for this one each
 * announcement anchored after the turn it followed. Announcements stay where Claude Code placed them, even on a
 * conversation's first step: moving them to its start would change the prefix of a long history, as after a model
 * switch the latest values did not cover.
 */
const record = async (input: {
  readonly announced: readonly Attachment[]
  readonly seedKey: string
  readonly context: ConversationContext
  readonly conversation: ReturnType<typeof conversationOf>
  readonly contextFile: string | undefined
  /** A conversation's first step fixes its initial attachments even when Claude Code announces nothing new. */
  readonly fresh: boolean
}) => {
  // The latest values are full snapshots; change markers and deltas belong to the conversation that saw them.
  const state = input.announced.filter((attachment) => SEEDED.has(attachment.type))
  const latest = new Map((seeds.get(input.seedKey) ?? []).map((attachment) => [attachment.type, attachment]))
  for (const { changes: _, changed: __, ...attachment } of state) latest.set(attachment.type, attachment)
  if (state.length > 0) seeds.set(input.seedKey, [...latest.values()])
  if (!input.contextFile || (input.announced.length === 0 && !input.fresh)) return
  const next = {
    ...input.context,
    anchored: [
      ...input.context.anchored,
      ...input.announced.map((attachment) => ({
        after: input.conversation.turns.length,
        prefix: input.conversation.prefixes.at(-1)!,
        attachment,
      })),
    ],
  }
  await saveContext(input.contextFile, next)
}

/**
 * Claude Code's auto memory for the project, rendered as the system prompt section a conversation starts with. Claude
 * Code adds its own section only to its default system prompt, and would rebuild it in every step's process, so a
 * memory saved mid-conversation would re-cache the whole conversation; like Claude Code's once-per-session section,
 * the snapshot stays fixed for the conversation, whose model sees what it saved through its own writes. The store
 * and the file format are Claude Code's, so native sessions read what these ones save.
 */
const memory = async (root: string, settings: Awaited<ReturnType<typeof loginSettings>>, connection: Connection) => {
  if (settings.autoMemoryEnabled === false) return undefined
  const configured = settings.autoMemoryDirectory?.replace(/^~(?=\/|$)/, connection.env.HOME ?? homedir())
  const directory = configured ?? path.join(root, "projects", projectKey(connection.project), "memory")
  const lines = (await readFile(path.join(directory, "MEMORY.md"), "utf8").catch(() => "")).trimEnd().split("\n")
  const index = lines.slice(0, MEMORY_INDEX_LINES).join("\n")
  return [
    "# Memory",
    "",
    `You have a persistent, file-based memory at \`${directory}\`, shared with Claude Code sessions in this project. Its index, \`MEMORY.md\`, is below as it stood when this conversation started.`,
    "",
    "Save what a later conversation will need and cannot recover from the repository or its history: who the user is and how they want you to work, their corrections and the approaches they confirmed (with the reason), ongoing goals and constraints, and pointers to external resources. Keep one fact per file:",
    "",
    "```markdown",
    "---",
    "name: <short-kebab-case-slug>",
    "description: <one-line summary, used to decide relevance>",
    "metadata:",
    "  type: user | feedback | project | reference",
    "---",
    "",
    "<the fact; for feedback and project, follow it with **Why:** and **How to apply:** lines>",
    "```",
    "",
    "Then add a one-line pointer to `MEMORY.md`: `- [Title](file.md) — hook`. Write absolute dates. Update the file that already covers a fact instead of adding another, and delete a memory that turns out to be wrong. A memory records what was true when it was written: check a file, function, or flag it names before relying on it.",
    "",
    "## MEMORY.md",
    "",
    index === "" ? "(empty)" : index,
    ...(lines.length > MEMORY_INDEX_LINES ? ["", `(Only the first ${MEMORY_INDEX_LINES} lines are shown.)`] : []),
  ].join("\n")
}

// Claude Code loads the same number of index lines.
const MEMORY_INDEX_LINES = 200

// Cleanup never fails a step whose response already completed.
const remove = (file: string, sessionId: string) =>
  Promise.all([
    rm(file, { force: true }),
    rm(path.join(path.dirname(file), sessionId), { recursive: true, force: true }),
  ])
    .then(() => rmdir(path.dirname(file)))
    .catch(() => undefined)

function start(
  query: (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query,
  connection: Connection,
  body: Body,
  sessionId: string,
  entries: ReturnType<typeof transcript>,
  child: { exited: Promise<void>; stderr: string },
  memory: string | undefined,
  advisorModel: string | undefined,
) {
  const search = body.tools?.some((tool) => tool.name === SEARCH) === true
  const tools = (body.tools ?? []).filter((tool) => tool.name !== SEARCH)
  return query({
    // Everything, including the newest message, lives in the transcript: a prompt carrying the newest message
    // would have its images re-attached as saved files and its text rewritten. `resumeSessionAt` resumes at
    // the transcript's last entry, which the empty prompt then completes.
    prompt: (async function* () {
      yield { type: "user", message: { role: "user", content: [] }, parent_tool_use_id: null }
    })(),
    options: {
      pathToClaudeCodeExecutable: connection.executable,
      cwd: connection.directory,
      model: body.model,
      systemPrompt:
        body.system === undefined && memory === undefined
          ? ""
          : [...(body.system?.map((block) => block.text) ?? []), ...(memory === undefined ? [] : [memory])],
      // Search stays Claude Code's own tool: it runs as a separate request inside Claude Code, answered before
      // this step ends; OpenCode's tools are advertised and executed by OpenCode.
      tools: search ? [CLAUDE_SEARCH] : [],
      mcpServers: { opencode: { type: "sdk", name: "opencode", instance: advertise(tools) } },
      allowedTools: [...tools.map((tool) => tool.name), ...(search ? [CLAUDE_SEARCH] : [])],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      plugins: [],
      skills: [],
      agents: {},
      // Claude Code's advisor: a stronger model reviews the conversation inside the same response, when the login
      // chose one (`/advisor`) and Claude Code finds it at least as capable as the session's model.
      settings: advisorModel === undefined ? {} : { advisorModel },
      maxTurns: 1,
      includePartialMessages: true,
      verbatimPrompts: true,
      persistSession: true,
      resume: sessionId,
      resumeSessionAt: entries.last,
      thinking: thinking(body.thinking),
      // Claude Code fills an omitted effort with its own default; the API's default is the protocol's.
      effort: (entries.effort ?? AnthropicMessages.DEFAULT_EFFORT) as Options["effort"],
      env: { ...connection.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(body.max_tokens) },
      // Claude Code flushes its transcript and session registration while exiting, so cleanup waits for the exit.
      spawnClaudeCodeProcess: (options) => {
        const claude = spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          signal: options.signal,
          stdio: ["pipe", "pipe", "pipe"],
        })
        child.exited = new Promise((done) => claude.once("exit", () => done()).once("error", () => done()))
        claude.stderr.on("data", (chunk: Buffer) => {
          child.stderr = (child.stderr + chunk.toString()).slice(-4096)
        })
        return claude
      },
    },
  })
}

/**
 * Claude Code reports its session to Anthropic on every request. Derive it from the OpenCode Session and the
 * login, so one conversation keeps one identity per account; a concurrent request of the same Session (a
 * title generation during a step) takes the next derived identity, since each step owns its transcript file.
 */
const active = new Set<string>()

const claim = (connection: Connection, session: string | undefined) => {
  const derive = (attempt: number) => {
    const hash = createHash("sha256")
      .update(ProviderShared.encodeJson([connection.env.CLAUDE_CONFIG_DIR, connection.account, session, attempt]))
      .digest()
    hash[6] = (hash[6]! & 0x0f) | 0x50
    hash[8] = (hash[8]! & 0x3f) | 0x80
    const hex = hash.subarray(0, 16).toString("hex")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  const free = (attempt: number): string => (active.has(derive(attempt)) ? free(attempt + 1) : derive(attempt))
  const id = session === undefined ? randomUUID() : free(0)
  active.add(id)
  return id
}

/** Claude Code's transcript file name for a directory, including its hashed form for long paths. */
export const projectKey = (directory: string) => {
  const key = directory.replace(/[^a-zA-Z0-9]/g, "-")
  if (key.length <= 200) return key
  // Claude Code hashes UTF-16 code units, not code points.
  const hash = Array.from({ length: directory.length }, (_, index) => directory.charCodeAt(index)).reduce(
    (value, unit) => (value * 31 + unit) | 0,
    0,
  )
  return `${key.slice(0, 200)}-${Math.abs(hash).toString(36)}`
}

/**
 * The conversation as Claude Code's API turns: adjacent same-role messages merged (Claude Code joins adjacent
 * entries with an inserted newline; one entry per turn keeps the content exact), effort markers folded into the
 * effort of the assistant turns they govern, and a hash of every prefix for anchoring attachments.
 */
function conversationOf(body: Body) {
  const turns = body.messages.reduce(
    (state, message: Message) => {
      if (message.role === "system") return { ...state, effort: message.output_config?.effort ?? state.effort }
      const previous = state.turns.at(-1)
      if (previous?.role === message.role)
        return {
          ...state,
          turns: [...state.turns.slice(0, -1), { ...previous, content: [...previous.content, ...message.content] }],
        }
      return {
        ...state,
        turns: [...state.turns, { role: message.role, content: [...message.content], effort: state.effort }],
      }
    },
    {
      effort: body.output_config?.effort,
      turns: [] as Array<{ role: "user" | "assistant"; content: Array<object>; effort: string | undefined }>,
    },
  )
  const prefixes = turns.turns.reduce(
    (hashes, turn) => [
      ...hashes,
      createHash("sha256").update(hashes.at(-1)!).update(ProviderShared.encodeJson(turn)).digest("hex"),
    ],
    [""],
  )
  return { ...turns, prefixes }
}

function transcript(
  body: Body,
  conversation: ReturnType<typeof conversationOf>,
  cwd: string,
  sessionId: string,
  context: ConversationContext,
) {
  const timestamp = new Date().toISOString()
  const attachment = (value: Attachment) => ({ type: "attachment", attachment: value })
  const turns = conversation
  const chained = [
    ...context.initial.map(attachment),
    ...turns.turns.flatMap((turn, index) => [
      turn.role === "user"
        ? { type: "user", message: { role: "user", content: turn.content } }
        : {
            type: "assistant",
            ...(turn.effort === undefined ? {} : { effort: turn.effort, perTurnEffort: turn.effort }),
            message: {
              id: `msg_${randomUUID().replaceAll("-", "")}`,
              type: "message",
              role: "assistant",
              // Claude Code drops thinking it attributes to another model; OpenCode already decided what replays.
              model: body.model,
              content: turn.content,
              stop_reason: turn.content.some((block) => "type" in block && block.type === "tool_use")
                ? "tool_use"
                : "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          },
      ...context.anchored.flatMap((anchored) =>
        anchored.after === index + 1 ? [attachment(anchored.attachment)] : [],
      ),
    ]),
  ].reduce(
    (state, entry) => {
      const uuid = randomUUID()
      return {
        parent: uuid,
        lines: [
          ...state.lines,
          {
            parentUuid: state.parent,
            isSidechain: false,
            userType: "external",
            cwd,
            sessionId,
            uuid,
            timestamp,
            ...entry,
          },
        ],
      }
    },
    { parent: null as string | null, lines: [] as object[] },
  )
  return { lines: chained.lines, last: chained.parent ?? undefined, effort: turns.effort }
}

// An omitted thinking configuration means none, not Claude Code's per-model default.
const thinking = (config: Body["thinking"]): Options["thinking"] => {
  if (config === undefined || config.type === "disabled") return { type: "disabled" }
  // Display values OpenCode admits for future API versions pass through for Claude Code to accept or reject.
  const display = config.display as "summarized" | "omitted" | undefined
  if (config.type === "enabled")
    return { type: "enabled", budgetTokens: config.budget_tokens, ...(display ? { display } : {}) }
  return { type: "adaptive", ...(display ? { display } : {}) }
}

/**
 * An in-process MCP server that advertises OpenCode's tool definitions verbatim. OpenCode executes every call
 * from the streamed `tool_use`; the SDK may still dispatch one before the stream closes, so calls are inert.
 */
const advertise = (tools: NonNullable<Body["tools"]>) =>
  ({
    connect: async (channel: {
      onmessage?: (message: { id?: number | string; method?: string; params?: { protocolVersion?: string } }) => void
      send: (message: object) => Promise<void>
      start?: () => Promise<void>
    }) => {
      channel.onmessage = (message) => {
        if (message.id === undefined) return
        const reply = (result: object) => channel.send({ jsonrpc: "2.0", id: message.id, result })
        if (message.method === "initialize")
          return reply({
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "opencode", version: "1" },
          })
        if (message.method === "ping") return reply({})
        if (message.method === "tools/list")
          return reply({
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.input_schema,
            })),
          })
        if (message.method === "tools/call")
          return reply({ isError: true, content: [{ type: "text", text: "OpenCode executes this call." }] })
        return channel.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })
      }
      await channel.start?.()
    },
  }) as unknown as McpSdkServerConfigWithInstance["instance"]

/**
 * A failure Claude Code reported: its message, the HTTP status it observed, its own error code (named in the
 * Anthropic API error vocabulary for classification), and the subscription limit's reset time.
 */
type Reported = {
  readonly message: string
  readonly status?: number
  readonly code?: string
  readonly resetsAt?: number
}

// Claude Code's error codes, in the Anthropic API error vocabulary the shared classifier reads.
const API_ERROR_TYPE: Record<string, string> = {
  authentication_failed: "authentication_error",
  oauth_org_not_allowed: "permission_error",
  account_on_hold: "permission_error",
  verification_required: "permission_error",
  invalid_request: "invalid_request_error",
  overloaded: "overloaded_error",
}

const reportedFailure = (reported: Reported) =>
  httpFailure({
    message: reported.message,
    status: reported.status,
    data: reported.code && { error: { type: API_ERROR_TYPE[reported.code] ?? reported.code } },
    responseHeaders:
      reported.resetsAt === undefined
        ? undefined
        : { "retry-after-ms": String(Math.max(0, reported.resetsAt * 1000 - Date.now())) },
  })

const incomplete = (message: string) =>
  new AIError({ reason: new InvalidProviderOutputError({ message, classification: "incomplete-stream" }) })

/**
 * One model response: the raw Anthropic stream events of the top-level message, ending at `message_stop`. A
 * WebSearch call is Claude Code's to run, so it streams as a provider-run `web_search` call and the response
 * ends only once Claude Code has answered it with a result block carrying its own result text.
 */
const frames = (run: Query, child: { readonly stderr: string }) => {
  const state = {
    started: false,
    stopped: false,
    reported: undefined as Reported | undefined,
    resetsAt: undefined as number | undefined,
    blocks: 0,
    searches: new Set<string>(),
    held: [] as string[],
  }
  const emit = (frames: ReadonlyArray<string>, final: boolean) =>
    Stream.fromIterable(frames.map((frame, index) => ({ frame, final: final && index === frames.length - 1 })))
  // The Query itself is the iterable: its `return()` closes Claude Code even while a message is still pending,
  // which the generator behind `Symbol.asyncIterator` would only honor after that message arrived.
  return Stream.fromAsyncIterable({ [Symbol.asyncIterator]: () => run }, (cause) =>
    // After an API failure the SDK throws a generic error; the structured report precedes it.
    state.reported ? reportedFailure(state.reported) : processFailure(cause, child.stderr),
  ).pipe(
    Stream.flatMap((message) => {
      if (message.type === "rate_limit_event" && message.rate_limit_info.status === "rejected")
        state.resetsAt = message.rate_limit_info.resetsAt
      if (message.type === "assistant" && message.error)
        state.reported = {
          message:
            message.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n") ||
            message.error,
          code: message.error,
          resetsAt: state.resetsAt,
        }
      if (message.type === "result" && message.is_error)
        state.reported = {
          message: state.reported?.message ?? ("result" in message ? message.result : message.subtype),
          status: ("api_error_status" in message ? message.api_error_status : undefined) ?? undefined,
          code: state.reported?.code,
          resetsAt: state.resetsAt,
        }
      if (message.type === "user" && message.parent_tool_use_id === null && state.searches.size > 0) {
        const answered = searchResults(message, state.searches)
        answered.forEach((result) => state.searches.delete(result.id))
        const results = answered.flatMap((result) => {
          const index = state.blocks++
          return [
            ProviderShared.encodeJson({
              type: "content_block_start",
              index,
              content_block: { type: "web_search_tool_result", tool_use_id: result.id, content: result.content },
            }),
            ProviderShared.encodeJson({ type: "content_block_stop", index }),
          ]
        })
        if (state.searches.size > 0 || state.held.length === 0) return emit(results, false)
        state.stopped = true
        return emit([...results, ...state.held], true)
      }
      if (
        message.type !== "stream_event" ||
        message.parent_tool_use_id !== null ||
        !AnthropicMessages.SSE_EVENTS.has(message.event.type)
      )
        return Stream.empty
      const event = message.event
      if (event.type === "message_start") {
        if (state.started) return Stream.fail(incomplete("Claude Code restarted the response"))
        state.started = true
      }
      if (event.type === "content_block_start") {
        state.blocks = Math.max(state.blocks, event.index + 1)
        if (event.content_block.type === "tool_use" && event.content_block.name === CLAUDE_SEARCH) {
          state.searches.add(event.content_block.id)
          return emit(
            [
              ProviderShared.encodeJson({
                ...event,
                content_block: { ...event.content_block, type: "server_tool_use", name: SEARCH },
              }),
            ],
            false,
          )
        }
      }
      if (state.searches.size > 0 && (event.type === "message_delta" || event.type === "message_stop")) {
        state.held.push(ProviderShared.encodeJson(event))
        return Stream.empty
      }
      state.stopped = event.type === "message_stop"
      return emit([ProviderShared.encodeJson(event)], state.stopped)
    }),
    Stream.takeUntil((item) => item.final),
    Stream.map((item) => item.frame),
    Stream.concat(
      Stream.suspend(() =>
        state.stopped
          ? Stream.empty
          : Stream.fail(
              state.reported
                ? reportedFailure(state.reported)
                : state.started
                  ? incomplete("Claude Code ended before the response completed")
                  : processFailure("Claude Code ended before responding", child.stderr),
            ),
      ),
    ),
  )
}

// Claude Code's WebSearch output: model commentary strings and, per server search, the result links.
const decodeSearch = Schema.decodeUnknownOption(
  Schema.Struct({
    results: Schema.Array(
      Schema.Union([
        Schema.String,
        Schema.Struct({
          content: Schema.Array(Schema.Struct({ title: Schema.optional(Schema.String), url: Schema.String })),
        }),
      ]),
    ),
  }),
)

/** The answers in a Claude Code tool-result message to pending searches, as `web_search_tool_result` content. */
const searchResults = (message: SDKUserMessage, pending: ReadonlySet<string>) => {
  const content = typeof message.message.content === "string" ? [] : message.message.content
  const links = Option.match(decodeSearch(message.tool_use_result), {
    onNone: () => [],
    onSome: (output) => output.results.flatMap((result) => (typeof result === "string" ? [] : result.content)),
  })
  return content.flatMap((block) => {
    if (block.type !== "tool_result" || !pending.has(block.tool_use_id)) return []
    const text =
      typeof block.content === "string"
        ? block.content
        : (block.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
    return [
      {
        id: block.tool_use_id,
        content: block.is_error ? { type: SEARCH_ERROR, error_code: "unavailable", text } : { text, results: links },
      },
    ]
  })
}

const processFailure = (cause: unknown, stderr: string) =>
  new AIError({
    reason: new TransportError({
      message: [cause instanceof Error ? cause.message : String(cause), stderr.trim()]
        .filter((part) => part.length > 0)
        .join("\n"),
      transport: "process",
      operation: "request",
      cause,
    }),
  })

export * as ClaudeCode from "./claude-code.js"
