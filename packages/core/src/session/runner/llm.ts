export * as SessionRunnerLLM from "./llm.js"

import { Message } from "@opencode-ai/ai"
import { Cause, Config, Effect, Exit, FiberMap, Layer, Pull, Schedule } from "effect"
import { Database } from "../../database/database.js"
import { Bus } from "../../bus.js"
import { InstructionState } from "../instruction-state.js"
import { SessionCompaction } from "../compaction.js"
import { SessionContext } from "../context.js"
import { SessionEvent } from "../event.js"
import { SessionHistory } from "../history.js"
import { SessionInbox } from "../inbox.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionModelTransport } from "../model-transport.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"
import { SessionStore } from "../store.js"
import { SessionTitle } from "../title.js"
import { DrainResult, Service, type Continuation } from "./index.js"
import { Snapshot } from "../../snapshot.js"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { llmClient } from "../../effect/app-node-platform.js"
import { StepFailedError } from "../error.js"
import { SessionRunnerRetry } from "./retry.js"
import type { SessionRunnerModel } from "./model.js"
import { SessionStep } from "./step.js"
import { ToolOutput } from "../../tool-output.js"
import { PluginSupervisor } from "../../plugin/supervisor.js"
import { PluginHooks } from "../../plugin/hooks.js"
import { PromptCacheDiagnostics } from "../prompt-cache-diagnostics.js"
import { MAX_STEPS_PROMPT } from "./max-steps.js"

const CONTINUE_AFTER_INCOMPLETE_STREAM =
  "The previous response was interrupted. Continue from where you left off without repeating completed content."

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const context = yield* SessionContext.Service
    const modelTransport = yield* SessionModelTransport.Service
    const db = (yield* Database.Service).db
    const compaction = yield* SessionCompaction.Service
    const plugins = yield* PluginSupervisor.Service
    const title = yield* SessionTitle.Service
    const hooks = yield* PluginHooks.Service
    const steps = yield* SessionStep.make
    const diagnostics = yield* Config.boolean("OPENCODE_PROMPT_CACHE_DIAGNOSTICS").pipe(
      Config.withDefault(false),
      Effect.orDie,
    )
    const promptCacheSnapshots = diagnostics ? new Map<string, PromptCacheDiagnostics.Snapshot>() : undefined
    const diagnosePromptCache = Effect.fn("SessionRunner.diagnosePromptCache")(function* (
      sessionID: SessionSchema.ID,
      request: Parameters<typeof PromptCacheDiagnostics.snapshot>[0],
    ) {
      if (!promptCacheSnapshots) return
      const current = PromptCacheDiagnostics.snapshot(request)
      const comparison = PromptCacheDiagnostics.compare(promptCacheSnapshots.get(sessionID), current)
      promptCacheSnapshots.delete(sessionID)
      promptCacheSnapshots.set(sessionID, current)
      const oldest = promptCacheSnapshots.keys().next().value
      if (promptCacheSnapshots.size > 100 && oldest !== undefined) promptCacheSnapshots.delete(oldest)
      yield* Effect.logInfo("prompt cache prefix").pipe(
        Effect.annotateLogs({
          sessionID,
          toolCount: current.tools.length,
          systemParts: current.system.length,
          messageCount: current.messages.length,
          ...comparison,
        }),
      )
    })
    // Title generation starts once input is visible and must not delay model execution.
    const titles = yield* FiberMap.make<SessionSchema.ID, void, never>()

    const drain = Effect.fn("SessionRunner.drain")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
      readonly continuation?: Continuation
      readonly promotable?: SessionInbox.Promotable
    }) {
      const sessionID = input.sessionID
      const history = SessionHistory.makeCache()
      let interactive = false
      let force = input.force
      let continuing = input.continuation !== undefined
      let step = input.continuation?.step ?? 1
      let entering = true
      const promotable = input.promotable ?? "input"
      if (!force && !continuing) {
        const pending = yield* SessionInbox.nextPromotable(db, sessionID, "input")
        if (
          !pending ||
          (pending.delivery === "queue" &&
            promotable === "steer" &&
            pending.type !== "compaction" &&
            pending.type !== "move")
        )
          return DrainResult.Complete()
      }
      yield* plugins.flush
      yield* settleStaleToolCalls(sessionID, history)

      const advanceToStep = Effect.fn("SessionRunner.advanceToStep")(() =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            while (true) {
              // Location entry and idle boundaries allow queued controls, not necessarily queued prompts.
              const pending = yield* SessionInbox.serialized(
                sessionID,
                Effect.gen(function* () {
                  const next = yield* SessionInbox.nextPromotable(
                    db,
                    sessionID,
                    entering || !continuing ? "input" : "steer",
                  )
                  if (next?.type === "compaction")
                    yield* bus.publishAll([
                      [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                      [SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "", inputID: next.id }],
                    ])
                  if (next?.type === "move")
                    yield* restore(
                      Effect.gen(function* () {
                        yield* modelTransport.close(sessionID)
                        yield* bus.publishAll([
                          [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                          [SessionEvent.Moved, { sessionID, ...next.payload }],
                        ])
                      }),
                    )
                  return next
                }),
              )
              if (!continuing && pending?.delivery !== "steer") {
                entering = true
                step = 1
              }
              if (pending?.type === "move")
                return DrainResult.Moved({ continuation: !entering && continuing ? { step } : undefined })
              if (pending?.type === "compaction") {
                const session = yield* store.get(sessionID)
                if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
                const compacted = yield* restore(
                  Effect.gen(function* () {
                    return yield* compaction.compactManual({
                      session,
                      resolveModel: context.resolveModel,
                      prepare: context.prepare,
                      messages: yield* store.context(sessionID, history),
                      inputID: pending.id,
                      started: true,
                      prepareRequest: (resolved) =>
                        prepareContext(sessionID).pipe(
                          Effect.flatMap((selection) => context.load(selection, history)),
                          Effect.flatMap((loaded) => requestForPrefix(loaded, resolved)),
                          Effect.orElseSucceed(() => undefined),
                        ),
                    })
                  }),
                ).pipe(Effect.exit)
                if (Exit.isFailure(compacted)) {
                  yield* bus.publish(SessionEvent.Compaction.Failed, {
                    sessionID,
                    reason: "manual",
                    error: Cause.hasInterruptsOnly(compacted.cause)
                      ? { type: "aborted", message: "Compaction cancelled" }
                      : { type: "compaction.failed", message: Cause.pretty(compacted.cause) },
                    inputID: pending.id,
                  })
                  return yield* Effect.failCause(compacted.cause)
                }
                force = false
                continue
              }
              if (!force && !continuing && (!pending || (pending.delivery === "queue" && promotable === "steer"))) {
                // Consulted at every idle boundary of the drain, not once: a continuation the model works
                // through can leave new unfinished work behind, and only the hook knows whether it did.
                // Bounding repetition is the hook's job -- one that always continues never lets the drain end.
                if (!(yield* hooks.has("session", "before-complete"))) return DrainResult.Complete()
                // Restored: a plugin hook must not run uninterruptibly, and neither must the admit.
                const continuation = yield* restore(
                  hooks.trigger("session", "before-complete", { sessionID, interactive }),
                ).pipe(Effect.exit)
                if (Exit.isFailure(continuation)) {
                  if (Cause.hasInterrupts(continuation.cause)) return yield* Effect.failCause(continuation.cause)
                  yield* Effect.logWarning("Session completion hook failed", continuation.cause).pipe(
                    Effect.annotateLogs({ sessionID }),
                  )
                  return DrainResult.Complete()
                }
                const requested = continuation.value.continuation
                if (requested === undefined) return DrainResult.Complete()
                // Suspended: Item.make validates synchronously and throws, so constructing it outside
                // the effect would escape Effect.exit and fail the session on a bad plugin continuation.
                const admitted = yield* restore(
                  Effect.suspend(() =>
                    SessionInbox.admit(db, bus, {
                      id: SessionMessage.ID.create(),
                      sessionID,
                      item: SessionInbox.Item.make({
                        type: "synthetic",
                        payload: {
                          text: requested.text,
                          description: requested.description,
                          metadata: requested.metadata,
                        },
                        delivery: "steer",
                      }),
                    }),
                  ),
                ).pipe(Effect.exit)
                if (Exit.isFailure(admitted)) {
                  if (Cause.hasInterrupts(admitted.cause)) return yield* Effect.failCause(admitted.cause)
                  yield* Effect.logWarning("Session completion continuation was not admitted", admitted.cause).pipe(
                    Effect.annotateLogs({ sessionID }),
                  )
                  return DrainResult.Complete()
                }
                force = true
                continue
              }
              // Only the input this drain is entering on: a steer promoted mid-drain has other work
              // behind it, and a withdrawn one must not end the turn.
              const expectedInputID =
                entering && !continuing && (pending?.type === "user" || pending?.type === "synthetic")
                  ? pending.id
                  : undefined
              return yield* restore(
                Effect.gen(function* () {
                  const selected = yield* prepareContext(sessionID)
                  const promoted = yield* SessionInbox.promote(
                    db,
                    bus,
                    sessionID,
                    entering && !continuing ? promotable : "steer",
                  )
                  // The probed input can be withdrawn between the probe and the promote. Going ahead
                  // would call the model with nothing new in the transcript.
                  if (expectedInputID !== undefined && promoted === 0) return DrainResult.Complete()
                  if (promoted > 0 && !selected.session.parentID && SessionTitle.isUntitled(selected.session))
                    yield* FiberMap.run(titles, sessionID, title.generate(sessionID).pipe(Effect.ignore), {
                      onlyIfMissing: true,
                    })
                  if (promoted > 0) step = 1
                  return { _tag: "Ready" as const, context: yield* context.load(selected, history) }
                }),
              )
            }
          }),
        ),
      )

      while (true) {
        const next = yield* advanceToStep()
        if (next._tag !== "Ready") return next
        const stepped = yield* runStep(next.context, step, history)
        continuing = stepped.continuing
        if (stepped.interactive !== undefined) interactive = stepped.interactive
        step++
        force = false
        entering = false
      }
    })

    /**
     * The request this turn would send, handed to compaction so the summarizer reuses the prefix the
     * provider has already cached. Failing to build one only costs the optimization.
     */
    const requestForPrefix = (loaded: SessionContext.Loaded, resolved: SessionRunnerModel.Resolved) =>
      Effect.gen(function* () {
        const transcript = SessionModelRequest.baseTranscript({
          agent: loaded.agent.info,
          model: resolved,
          tools: loaded.tools,
          initial: loaded.initial,
          messages: loaded.messages,
        })
        const prepared = yield* context.prepare({
          scope: { session: loaded.session, agentID: loaded.agent.id, model: resolved, tools: loaded.tools },
          transcript: { system: transcript.system, messages: transcript.messages },
          webSocket: "session",
        })
        return prepared.request
      }).pipe(Effect.orElseSucceed(() => undefined))

    const prepareContext = Effect.fn("SessionRunner.prepareContext")(function* (sessionID: SessionSchema.ID) {
      const selected = yield* context.select(sessionID)
      // A blocked initial instruction baseline must leave admitted input pending.
      yield* InstructionState.prepare(db, bus, selected.instructions, sessionID)
      return selected
    })

    /** Owns logical Step policy; each attempt owns its streaming, tools, and durable settlement. */
    const runStep = Effect.fn("SessionRunner.runStep")(function* (
      first: SessionContext.Loaded,
      step: number,
      history: SessionHistory.Cache,
    ) {
      const sessionID = first.session.id
      let assistantMessageID = SessionMessage.ID.create()
      const retry = yield* Schedule.toStepWithSleep(SessionRunnerRetry.schedule(bus, sessionID))
      let initial: SessionContext.Loaded | undefined = first
      let recoverOverflow = true
      let recoverContinuation = true
      while (true) {
        // Reuse boundary preparation once; retries refresh context without delivering more input.
        const loaded =
          initial ?? (yield* prepareContext(sessionID).pipe(Effect.flatMap((selection) => context.load(selection, history))))
        initial = undefined
        const compactionInput = {
          session: loaded.session,
          messages: loaded.messages,
          resolved: loaded.model,
          prepare: context.prepare,
          prepareRequest: (resolved: SessionRunnerModel.Resolved) => requestForPrefix(loaded, resolved),
        }
        if (compaction.required(compactionInput)) {
          const compacted = yield* compaction.compact(compactionInput)
          if (compacted.status !== "completed") return yield* new StepFailedError({ error: compacted.error })
          assistantMessageID = SessionMessage.ID.create()
          continue
        }
        const stepLimitReached = loaded.agent.info.steps !== undefined && step >= loaded.agent.info.steps
        const transcript = SessionModelRequest.baseTranscript({
          agent: loaded.agent.info,
          model: loaded.model,
          tools: loaded.tools,
          initial: loaded.initial,
          messages: loaded.messages,
        })
        const prepared = yield* context.prepare({
          scope: { session: loaded.session, agentID: loaded.agent.id, model: loaded.model, tools: loaded.tools },
          transcript: {
            system: transcript.system,
            messages: stepLimitReached
              ? [...transcript.messages, Message.assistant(MAX_STEPS_PROMPT)]
              : transcript.messages,
          },
          // Keep tool definitions on the final Step to preserve the provider's cached prefix.
          toolChoice: stepLimitReached ? "none" : undefined,
          webSocket: "session",
        })
        yield* diagnosePromptCache(sessionID, prepared.request)
        const outcome = yield* steps.attempt({
          sessionID,
          assistantMessageID,
          agent: loaded.agent.id,
          model: loaded.model,
          prepared,
          toolsDisabled: stepLimitReached,
          recoverContinuation,
          recoverOverflow: Effect.suspend(() =>
            recoverOverflow && compaction.enabled()
              ? compaction.compact(compactionInput).pipe(Effect.map((result) => result.status === "completed"))
              : Effect.succeed(false),
          ),
        })
        if (outcome._tag === "Completed")
          return { continuing: outcome.needsContinuation, interactive: outcome.interactive }
        if (outcome._tag === "Retry" || outcome._tag === "Continue") {
          yield* retry({ cause: outcome.cause, error: outcome.error, assistantMessageID }).pipe(
            Pull.catchDone(() =>
              Effect.gen(function* () {
                if (outcome._tag === "Retry")
                  yield* bus.publish(SessionEvent.Step.Failed, { sessionID, assistantMessageID, error: outcome.error })
                return yield* outcome.cause
              }),
            ),
          )
          if (outcome._tag === "Continue") {
            yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: CONTINUE_AFTER_INCOMPLETE_STREAM })
            assistantMessageID = SessionMessage.ID.create()
          }
          continue
        }
        if (outcome._tag === "Compacted") {
          recoverOverflow = false
          assistantMessageID = SessionMessage.ID.create()
          continue
        }
        recoverContinuation = false
      }
    })

    const settleStaleToolCalls = Effect.fn("SessionRunner.settleStaleToolCalls")(function* (
      sessionID: SessionSchema.ID,
      history: SessionHistory.Cache,
    ) {
      for (const message of yield* store.context(sessionID, history)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "streaming" && tool.state.status !== "running")) continue
          const metadata = tool.state.status === "running" ? tool.state.metadata : undefined
          const childID =
            tool.name === "subagent" && typeof metadata?.sessionID === "string" ? metadata.sessionID : undefined
          yield* bus.publish(SessionEvent.Tool.Failed, {
            sessionID,
            assistantMessageID: message.id,
            id: tool.id,
            error: {
              type: "aborted",
              message: `Tool execution interrupted: ${tool.name}${childID ? ` (sessionID: ${childID})` : ""}`,
            },
            ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
            executed: tool.executed === true,
          })
        }
      }
    })

    return Service.of({ drain })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    llmClient,
    SessionContext.node,
    SessionModelTransport.node,
    SessionStore.node,
    SessionCompaction.node,
    PluginSupervisor.node,
    PluginHooks.node,
    SessionTitle.node,
    Snapshot.node,
    ToolOutput.node,
    Database.node,
  ],
})
