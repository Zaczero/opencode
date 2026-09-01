import type { SessionApi } from "@opencode-ai/client/effect/api"
import type { GenerationOptionsFields, Message, SystemPart } from "@opencode-ai/ai"
import type { Agent } from "@opencode-ai/schema/agent"
import type { Model } from "@opencode-ai/schema/model"
import type { PromptInput } from "@opencode-ai/schema/prompt-input"
import type { Session } from "@opencode-ai/schema/session"
import type { SessionInbox } from "@opencode-ai/schema/session-inbox"
import type { SessionMessage } from "@opencode-ai/schema/session-message"
import type { Effect, JsonSchema, Types } from "effect"
import type { ModelHooks } from "./registration.js"

export interface SessionPrompt {
  readonly sessionID: Session.ID
  readonly messageID: SessionMessage.ID
  prompt: Types.DeepMutable<PromptInput.Prompt>
  metadata?: Record<string, unknown>
  delivery: SessionInbox.Delivery
}

export interface SessionContext {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  system: Array<SystemPart>
  messages: Array<Message>
  tools: Record<string, { description: string; input: JsonSchema.JsonSchema }>
  /** Request overrides; unset fields retain route and model defaults. */
  generation: Types.DeepMutable<GenerationOptionsFields>
  providerOptions: Record<string, unknown>
}

export interface SessionModelRequest {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  baseURL?: string
  headers: Record<string, string>
}

export interface SessionCompaction {
  readonly sessionID: Session.ID
  readonly reason: "auto" | "manual"
  readonly previousSummary?: string
  readonly context: ReadonlyArray<string>
  prompt: string
}

export interface SessionHttpRequest {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  request: Request
}

export interface SessionHttpResponse {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly request: Request
  response: Response
}

export interface SessionBeforeComplete {
  readonly sessionID: Session.ID
  /** The session stopped after an interactive question and should not be continued automatically. */
  readonly interactive: boolean
  /** Core admits this into `sessionID` before publishing the execution terminal. */
  continuation?: {
    readonly text: string
    readonly description?: string
    readonly metadata?: Record<string, unknown>
  }
}

export interface SessionHooks {
  readonly prompt: SessionPrompt
  readonly context: SessionContext
  readonly "model.request": SessionModelRequest
  readonly compaction: SessionCompaction
  readonly "http.request": SessionHttpRequest
  readonly "http.response": SessionHttpResponse
  readonly "before-complete": SessionBeforeComplete
}

export type SessionDomain = Pick<
  SessionApi<unknown>,
  | "create"
  | "get"
  | "switchAgent"
  | "switchModel"
  | "prompt"
  | "generate"
  | "command"
  | "synthetic"
  | "interrupt"
  | "rename"
  | "move"
  | "wait"
  | "context"
> & {
  /** Snapshot actual model executions with their durable busy-period start time. */
  readonly executing: Effect.Effect<ReadonlyArray<{ readonly sessionID: string; readonly startedAt: number }>>
  readonly hook: ModelHooks<SessionHooks>
}
