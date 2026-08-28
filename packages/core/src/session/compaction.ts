export * as SessionCompaction from "./compaction.js"

import { LLMClient, AIError, LLMEvent, LLMRequest, Message, ToolChoice } from "@opencode-ai/ai"
import type { StreamOptions } from "@opencode-ai/ai/route"
import { SessionError } from "@opencode-ai/schema/session-error"
import { Context, Effect, Layer, Stream } from "effect"
import { Bus } from "../bus.js"
import { PluginHooks } from "../plugin/hooks.js"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { llmClient } from "../effect/app-node-platform.js"
import { SessionEvent } from "./event.js"
import type { SessionContext } from "./context.js"
import type { SessionMessage } from "./message.js"
import type { SessionModelRequest } from "./model-request.js"
import type { SessionRunnerModel } from "./runner/model.js"
import { SessionSchema } from "./schema.js"
import { toSessionError } from "./to-session-error.js"
import { toLLMMessages } from "./runner/to-llm-message.js"
import { Token } from "../util/token.js"
import { SessionUsage } from "./usage.js"
import { Agent } from "../agent.js"
import { State } from "../state.js"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 15_000
const OUTPUT_TOKEN_MAX = 32_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`

export type Settings = {
  auto: boolean
  buffer: number
  tokens: number
}

export type Draft = {
  configure: (settings: Partial<Settings>) => void
}

type Dependencies = {
  readonly hooks: PluginHooks.Interface
  readonly bus: Bus.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest, options?: StreamOptions) => Stream.Stream<LLMEvent, AIError>
  }
}

/**
 * Builds the request whose cached prefix the summarizer reuses. Called only once compaction has
 * decided to run and resolved its model: an empty session must still fail without resolving one,
 * and a turn that never compacts must not pay to build a request it will not send.
 */
type PrepareRequest = (resolved: SessionRunnerModel.Resolved) => Effect.Effect<LLMRequest | undefined>

export type AutoInput = {
  readonly session: SessionSchema.Info
  readonly messages: readonly SessionMessage.Info[]
  readonly resolved: SessionRunnerModel.Resolved
  readonly prepare: SessionModelRequest.Interface["prepare"]
  readonly prepareRequest?: PrepareRequest
}

type RequiredInput = Pick<AutoInput, "messages" | "resolved">

export type ManualInput = {
  readonly session: SessionSchema.Info
  readonly messages: readonly SessionMessage.Info[]
  readonly inputID: SessionMessage.ID
  readonly started?: boolean
  /** Invoked after content planning, not when the caller captures the operation. */
  readonly resolveModel: SessionContext.Interface["resolveModel"]
  readonly prepare: SessionModelRequest.Interface["prepare"]
  readonly prepareRequest?: PrepareRequest
}

type Plan = {
  readonly session: SessionSchema.Info
  readonly resolved: SessionRunnerModel.Resolved
  readonly reason: SessionMessage.Compaction["reason"]
  readonly messages: readonly SessionMessage.Info[]
  readonly head: readonly SessionMessage.Info[]
  readonly request?: LLMRequest
  readonly previousSummary?: string
  readonly context: readonly string[]
  readonly prompt: string
  readonly recent: string
  readonly inputID?: SessionMessage.ID
  readonly started?: boolean
  readonly prepare: SessionModelRequest.Interface["prepare"]
}

export type Outcome =
  | Pick<SessionMessage.CompactionCompleted, "status">
  | Pick<SessionMessage.CompactionFailed, "status" | "error">

export interface Interface extends State.Transformable<Draft> {
  readonly enabled: () => boolean
  readonly required: (input: RequiredInput) => boolean
  readonly compact: (input: AutoInput) => Effect.Effect<Outcome>
  readonly compactManual: (input: ManualInput) => Effect.Effect<Outcome>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const truncateToolOutput = (value: string) => {
  if (value.length <= TOOL_OUTPUT_MAX_CHARS) return value
  let end = 0
  for (let count = 0; count < TOOL_OUTPUT_MAX_CHARS && end < value.length; count++) {
    const code = value.charCodeAt(end)
    end +=
      code >= 0xd800 && code <= 0xdbff && value.charCodeAt(end + 1) >= 0xdc00 && value.charCodeAt(end + 1) <= 0xdfff
        ? 2
        : 1
  }
  if (end === value.length) return value
  return `${value.slice(0, end)}\n[truncated]`
}

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serialize = (message: SessionMessage.Info) => {
  if (message.type === "user") {
    const files =
      message.files?.map(
        (file) =>
          `[Attached ${file.mime}: ${file.name ?? (file.source.type === "uri" ? file.source.uri : "inline attachment")}]`,
      ) ?? []
    const skills =
      message.skills?.flatMap((skill) =>
        skill.text === undefined ? [] : [`[Skill activated: ${skill.name}]\n${skill.text}`],
      ) ?? []
    return [...skills, `[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "location-switched")
    return `[User]: The working directory has been changed to ${message.location.directory}.`
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncateToolOutput(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "skill") return `[Skill activated: ${message.name}]\n${message.text}`
  if (message.type === "shell")
    return `[Shell]: ${message.command}\n${truncateToolOutput(message.output?.output ?? "")}`
  return ""
}

const hasCompletedCompaction = (messages: readonly SessionMessage.Info[]) =>
  messages.some((message) => message.type === "compaction" && message.status === "completed")

const prefixMessages = (messages: readonly SessionMessage.Info[], head: readonly SessionMessage.Info[]) => {
  const boundary = head.at(-1)?.id
  if (boundary === undefined)
    return messages.filter((message) => message.type === "compaction" || message.type === "system")
  const index = messages.findIndex((message) => message.id === boundary)
  return index < 0 ? messages : messages.slice(0, index + 1)
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  )
}

const sameMessageShape = (left: LLMRequest["messages"][number], right: LLMRequest["messages"][number]) =>
  JSON.stringify(canonical({ role: left.role, content: left.content })) ===
  JSON.stringify(canonical({ role: right.role, content: right.content }))

/**
 * The slice of an in-flight request the summarizer can reuse verbatim, so compaction hits the
 * provider's prompt cache instead of paying a cold prefix for a one-message request.
 */
const cachePrefix = (input: {
  readonly request: LLMRequest
  readonly messages: readonly SessionMessage.Info[]
  readonly head: readonly SessionMessage.Info[]
  readonly resolved: SessionRunnerModel.Resolved
}) => {
  const providerMetadataKey = input.resolved.model.route.providerMetadataKey ?? input.resolved.model.provider
  const source = prefixMessages(input.messages, input.head)
  const boundary = source.at(-1)?.id
  const boundaryIndex =
    boundary === undefined ? -1 : input.request.messages.findIndex((message) => message.id === boundary)
  let end = boundaryIndex + 1
  if (boundaryIndex < 0) {
    // Context hooks can insert id-less messages, so fall back to matching the lowered shapes in order.
    const lowered = toLLMMessages(source, input.resolved.ref, providerMetadataKey)
    end = 0
    for (const expected of lowered) {
      const identity =
        expected.id === undefined
          ? -1
          : input.request.messages.findIndex((message, position) => position >= end && message.id === expected.id)
      const index =
        identity >= 0
          ? identity
          : input.request.messages.findIndex(
              (message, position) => position >= end && sameMessageShape(message, expected),
            )
      if (index < 0) return []
      end = index + 1
    }
  }
  // Never split a tool call from its result.
  let complete = end
  while (complete > 0 && complete < input.request.messages.length && input.request.messages[complete]?.role === "tool")
    complete += 1
  return input.request.messages.slice(0, complete)
}

const select = (
  messages: readonly SessionMessage.Info[],
  tokens: number,
):
  | { readonly head: string; readonly headMessages: readonly SessionMessage.Info[]; readonly recent: string }
  | undefined => {
  const conversation = messages
    .filter((message) => message.type !== "compaction" && message.type !== "system")
    .flatMap((message) => {
      const text = serialize(message)
      return text ? [{ message, text }] : []
    })
  if (conversation.length === 0) return undefined
  let total = 0
  let split = conversation.length
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index].text)
    if (split < conversation.length && next > tokens) break
    total = next
    split = index
  }
  while (split > 0 && conversation[split].message.type !== "user") split--
  if (split === 0) {
    const latestUser = conversation.findLastIndex((item) => item.message.type === "user")
    if (latestUser > 0) split = latestUser
  }
  return {
    head: conversation
      .slice(0, split)
      .map((item) => item.text)
      .join("\n\n"),
    headMessages: conversation.slice(0, split).map((item) => item.message),
    recent: conversation
      .slice(split)
      .map((item) => item.text)
      .join("\n\n"),
  }
}

export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) =>
  [
    input.previousSummary
      ? `Update the anchored summary below using the conversation history above.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${input.previousSummary}\n</previous-summary>`
      : "Create a new anchored summary from the conversation history.",
    SUMMARY_TEMPLATE,
    "The following is the conversation history:",
    ...input.context,
  ].join("\n\n")

const planContent = (messages: readonly SessionMessage.Info[], tokens: number) => {
  const selected = select(messages, tokens)
  if (!selected) return
  const previousSummary = messages.findLast(
    (message): message is SessionMessage.CompactionCompleted =>
      message.type === "compaction" && message.status === "completed",
  )
  const previousRecent = previousSummary?.recent ?? ""
  const summarizeRecent = !previousRecent && !selected.head
  const context = summarizeRecent ? [selected.recent] : [previousRecent, selected.head].filter(Boolean)
  return {
    // Surfaced alongside the built prompt so the compaction hook can rebuild it rather than parse it.
    previousSummary: previousSummary?.summary,
    context,
    head: selected.headMessages,
    prompt: buildPrompt({ previousSummary: previousSummary?.summary, context }),
    recent: summarizeRecent ? "" : selected.recent,
  }
}

const make = (dependencies: Dependencies) => {
  const state = State.create<Settings, Draft>({
    name: "session-compaction",
    initial: () => ({ auto: true, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS }),
    draft: (draft) => ({
      configure: (settings) => {
        if (settings.auto !== undefined) draft.auto = settings.auto
        if (settings.buffer !== undefined) draft.buffer = settings.buffer
        if (settings.tokens !== undefined) draft.tokens = settings.tokens
      },
    }),
  })
  const failed = Effect.fnUntraced(function* (input: {
    readonly sessionID: SessionSchema.ID
    readonly reason: SessionMessage.Compaction["reason"]
    readonly error: SessionError.Error
    readonly inputID?: SessionMessage.ID
  }) {
    yield* dependencies.bus.publish(SessionEvent.Compaction.Failed, input)
    return { status: "failed" as const, error: input.error }
  })
  const execute = Effect.fn("SessionCompaction.execute")(function* (plan: Plan) {
    if (!plan.started)
      yield* dependencies.bus.publish(SessionEvent.Compaction.Started, {
        sessionID: plan.session.id,
        reason: plan.reason,
        recent: plan.recent,
        inputID: plan.inputID,
      })

    const chunks: string[] = []
    let failure: SessionError.Error | undefined
    let usage: SessionUsage.Recorded | undefined
    const recordUsage = Effect.suspend(() =>
      usage
        ? dependencies.bus.publish(SessionEvent.UsageRecorded, {
            sessionID: plan.session.id,
            source: "compaction",
            ...usage,
          })
        : Effect.void,
    )
    // The summarizer request is excluded from the session context hook, so this is the only seam a
    // plugin has to shape the compaction prompt.
    // Reuse the turn's cached prefix when there is one: the history then already sits in the
    // messages, so the prompt carries only the instruction and the context text is dropped from it.
    const firstCompaction = plan.head.length === 0 && !hasCompletedCompaction(plan.messages)
    const prefix =
      plan.request !== undefined && !firstCompaction
        ? cachePrefix({ request: plan.request, messages: plan.messages, head: plan.head, resolved: plan.resolved })
        : []
    const cachePreserved = prefix.length > 0
    const hooked = yield* dependencies.hooks.trigger("session", "compaction", {
      sessionID: plan.session.id,
      reason: plan.reason,
      previousSummary: cachePreserved ? undefined : plan.previousSummary,
      context: cachePreserved ? [] : [...plan.context],
      prompt: cachePreserved ? buildPrompt({ context: [] }) : plan.prompt,
    })
    const prepared = yield* plan.prepare({
      scope: { session: plan.session, agentID: Agent.ID.make("compaction"), model: plan.resolved },
      transcript: { system: [], messages: [Message.user(hooked.prompt)] },
      contextHooks: false,
    })
    const request =
      cachePreserved && plan.request
        ? LLMRequest.update(plan.request, {
            model: prepared.request.model,
            http: prepared.request.http,
            messages: [...prefix, Message.user(hooked.prompt)],
            toolChoice: ToolChoice.make({
              type: "none",
              disableParallelToolUse: plan.request.toolChoice?.disableParallelToolUse,
            }),
          })
        : prepared.request
    yield* dependencies.llm.stream(request, prepared.options).pipe(
      Stream.runForEach((event) => {
        if (LLMEvent.is.providerError(event))
          failure = {
            type: event.classification === "context-overflow" ? "provider.invalid-request" : "provider.error",
            message: event.message,
          }
        if (LLMEvent.is.textDelta(event)) {
          chunks.push(event.text)
          return dependencies.bus.publish(SessionEvent.Compaction.Delta, {
            sessionID: plan.session.id,
            text: event.text,
          })
        }
        if (LLMEvent.is.stepFinish(event)) {
          const step = SessionUsage.record(event.usage, plan.resolved.cost)
          usage = usage ? SessionUsage.add(usage, step) : step
        }
        return Effect.void
      }),
      Effect.catchTag("AI.Error", (error) =>
        Effect.sync(() => {
          failure = toSessionError(error)
        }),
      ),
      Effect.onInterrupt(() =>
        recordUsage.pipe(
          Effect.andThen(
            plan.reason === "auto"
              ? failed({
                  sessionID: plan.session.id,
                  reason: plan.reason,
                  error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
                  inputID: plan.inputID,
                }).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ),
    )
    yield* recordUsage
    const summary = chunks.join("")
    if (failure || !summary.trim()) {
      const error = failure ?? { type: "compaction.failed" as const, message: "Compaction produced no summary" }
      return yield* failed({
        sessionID: plan.session.id,
        reason: plan.reason,
        error,
        inputID: plan.inputID,
      })
    }
    yield* dependencies.bus.publish(SessionEvent.Compaction.Ended, {
      sessionID: plan.session.id,
      reason: plan.reason,
      text: summary,
      recent: plan.recent,
    })
    return { status: "completed" as const }
  })
  const compact = Effect.fn("SessionCompaction.compact")(function* (input: AutoInput) {
    const content = planContent(input.messages, state.get().tokens)
    if (content)
      return yield* execute({
        session: input.session,
        resolved: input.resolved,
        prepare: input.prepare,
        reason: "auto",
        messages: input.messages,
        request: input.prepareRequest ? yield* input.prepareRequest(input.resolved) : undefined,
        ...content,
      })
    return yield* failed({
      sessionID: input.session.id,
      reason: "auto",
      error: { type: "compaction.unavailable", message: "Nothing to compact yet" },
    })
  })
  const required = (input: RequiredInput) => {
    const config = state.get()
    if (!config.auto) return false
    const limit = input.resolved.limit
    const context = limit.context
    if (context <= 0) return false
    const last = input.messages.findLast(
      (message): message is SessionMessage.Assistant & { tokens: NonNullable<SessionMessage.Assistant["tokens"]> } =>
        message.type === "assistant" && message.tokens !== undefined,
    )
    if (!last) return false
    const output = Math.min(limit.output, OUTPUT_TOKEN_MAX)
    const promptCeiling = Math.min(
      limit.input === undefined ? Number.POSITIVE_INFINITY : limit.input - config.buffer,
      context - Math.max(output, config.buffer),
    )
    const used =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    if (used <= 0) return false
    return used >= promptCeiling
  }
  const compactManual = Effect.fn("SessionCompaction.compactManual")(function* (input: ManualInput) {
    const content = planContent(input.messages, state.get().tokens)
    if (!content)
      return yield* failed({
        sessionID: input.session.id,
        reason: "manual",
        error: { type: "compaction.unavailable", message: "Nothing to compact yet" },
        inputID: input.inputID,
      })
    const resolved = yield* input.resolveModel(input.session).pipe(
      Effect.catch((cause) =>
        failed({
          sessionID: input.session.id,
          reason: "manual",
          error: toSessionError(cause),
          inputID: input.inputID,
        }),
      ),
    )
    if ("status" in resolved) return resolved
    const request = input.prepareRequest ? yield* input.prepareRequest(resolved) : undefined
    return yield* execute({
      session: input.session,
      resolved,
      prepare: input.prepare,
      reason: "manual",
      messages: input.messages,
      request,
      inputID: input.inputID,
      started: input.started,
      ...content,
    })
  })
  return Service.of({
    transform: state.transform,
    reload: state.reload,
    enabled: () => state.get().auto,
    required,
    compact,
    compactManual,
  })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const llm = yield* LLMClient.Service
    const hooks = yield* PluginHooks.Service
    return make({ bus, llm, hooks })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, llmClient, PluginHooks.node],
})
