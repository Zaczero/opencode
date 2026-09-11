export * as SubagentTool from "./subagent.js"

import { ToolFailure } from "@opencode-ai/ai"
import type { Context } from "@opencode-ai/plugin/effect/plugin"
import { Duration, Effect, Schema } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { Job } from "../../job.js"
import { Session } from "../../session.js"
import { SubagentJob } from "../../session/subagent-job.js"
import { Permission } from "../../permission.js"
import { SessionSchema } from "../../session/schema.js"

export const name = "subagent"

const NO_TEXT = "Subagent completed without a text response."
const MAX_LISTED_SUBAGENTS = 30
const ABORT_POLICY =
  "Stop and report if the task's premise is false, its requirements conflict, or progress requires a decision outside your authority. Preserve your work, give the evidence, and name what would unblock you. Report user questions to your parent; only the root session can ask the user. Continue through difficulty, and do not silently narrow the task or substitute a lesser result. Your parent can resume this session with a corrected brief."
/** How long the interrupt tool waits for the child's cleanup before reporting the stop as merely accepted. */
const INTERRUPT_SETTLEMENT = Duration.seconds(15)
const backgroundResult = (sessionID: SessionSchema.ID) => ({
  sessionID,
  status: "running" as const,
  output: [
    `The subagent is working in the background (sessionID: ${sessionID}). You will be notified automatically when it finishes.`,
    "Do not poll, request status, or duplicate its work. Continue independent work; if none remains, end your response and wait for the completion notification.",
  ].join("\n"),
})

export const Input = Schema.Struct({
  agent: Schema.String.annotate({
    description:
      "Agent for this dispatch. Continuing a child can switch its agent, configured model, and reasoning settings in its existing session without restarting or losing the conversation",
  }),
  description: Schema.String.annotate({
    description: "Short 3-5 word label for this dispatch, displayed to the user",
  }),
  prompt: Schema.String.annotate({
    description: "Complete task for a new child, or additional instructions for a continued child",
  }),
  sessionID: Schema.optionalKey(SessionSchema.ID).annotate({
    description: "Child session to continue with its conversation intact. Omit to start a new child conversation",
  }),
  directory: Schema.optionalKey(Schema.String).annotate({
    description:
      "Starting directory for a new child. Relative paths resolve from this session; omit to inherit this session's directory. Ignored when continuing a child",
  }),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literal("running"),
  output: Schema.String,
})

const InspectInput = Schema.Struct({
  sessionID: SessionSchema.ID.annotate({ description: "Child session ID returned by subagent or subagent_list" }),
})
const InspectOutput = Schema.Struct({ output: Schema.String })
const inspectResult = (output: string) => ({ output: { output }, content: output })
export const description = [
  "Dispatch an agent into a child session to carry out a task.",
  "Without sessionID, this starts a blank child whose prompt must carry every fact it needs.",
  "With sessionID, this adds the prompt to the same child conversation and preserves its history.",
  "Every call runs in the background and returns immediately. You are notified when it finishes; do not poll progress.",
  "Continue a running child to steer it instead of dispatching duplicate work.",
  "Use subagent_interrupt to stop a child without a model round-trip; its conversation remains resumable.",
].join("\n")

export const Plugin = {
  id: "opencode.tool.subagent",
  effect: Effect.fn("SubagentTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const subagents = yield* SubagentJob.make
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const jobs = yield* Job.Service
    const permission = yield* Permission.Service
    // Concatenate the child's final completed assistant text. Distinguishes "completed with no
    // text" (generic string) from "failed" (the run effect fails, surfaced as a job error).
    const latestAssistantText = Effect.fn("SubagentTool.latestAssistantText")(function* (sessionID: SessionSchema.ID) {
      const messages = yield* sessions.messages({ sessionID, order: "desc", limit: 20 })
      const assistant = messages.find(
        (message) =>
          message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
      )
      if (assistant === undefined || assistant.type !== "assistant") return NO_TEXT
      const text = assistant.content
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("")
      return text.length > 0 ? text : NO_TEXT
    })

    const ownChild = Effect.fn("SubagentTool.ownChild")(function* (
      parentID: SessionSchema.ID,
      childID: SessionSchema.ID,
    ) {
      const child = yield* sessions.get(childID).pipe(Effect.option)
      if (child._tag === "None") return undefined
      return child.value.parentID === parentID ? child.value : undefined
    })

    yield* ctx.tool
      .transform((draft) => {
        draft.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const parent = yield* sessions
                .get(context.sessionID)
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                  ),
                )
              let current = parent
              let depth = 0
              while (current.parentID) {
                depth++
                current = yield* sessions
                  .get(current.parentID)
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Parent session not found: ${current.parentID}`, error }),
                    ),
                  )
              }
              const limit = Config.latest(yield* config.entries(), "experimental")?.subagent_depth ?? 1
              if (depth >= limit)
                return yield* new ToolFailure({
                  message: `Subagent depth limit reached (${limit}). Increase "experimental.subagent_depth" to allow nested subagents.`,
                })
              const agent = yield* agents.resolve(input.agent)
              if (agent === undefined) return yield* new ToolFailure({ message: `Unknown agent: ${input.agent}` })
              if (agent.mode === "primary")
                return yield* new ToolFailure({ message: `Agent ${input.agent} cannot run as a subagent` })
              yield* permission
                .assert({
                  action: name,
                  resources: [agent.id],
                  save: [agent.id],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: {
                    type: "tool",
                    messageID: context.messageID,
                    id: context.id,
                  },
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: `Subagent denied: ${agent.id}`, error })))

              const existing =
                input.sessionID === undefined
                  ? undefined
                  : yield* sessions
                      .get(input.sessionID)
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new ToolFailure({ message: `Subagent session not found: ${input.sessionID}`, error }),
                        ),
                      )
              if (existing !== undefined && existing.parentID !== context.sessionID)
                return yield* new ToolFailure({
                  message: `Session ${existing.id} is not a child of the current session`,
                })
              // Continuing with a different agent switches the child, mirroring create semantics
              // where the agent's configured model wins over the inherited one.
              if (existing !== undefined && existing.agent !== agent.id) {
                yield* sessions.switchAgent({ sessionID: existing.id, agent: agent.id }).pipe(
                  Effect.andThen(
                    agent.model === undefined
                      ? Effect.void
                      : sessions.switchModel({ sessionID: existing.id, model: agent.model }),
                  ),
                  Effect.mapError(
                    (error) =>
                      new ToolFailure({ message: `Failed to switch subagent session agent: ${existing.id}`, error }),
                  ),
                )
              }

              // Model selection is policy/config/session state, not an LLM-facing tool argument.
              const model = agent.model ?? parent.model
              const child =
                existing ??
                (yield* sessions
                  .create({
                    parentID: context.sessionID,
                    title: input.description,
                    agent: Agent.ID.make(input.agent),
                    model,
                    ...(input.directory === undefined ? {} : { directory: input.directory }),
                  })
                  .pipe(
                    Effect.mapError(
                      (error) =>
                        new ToolFailure({
                          message:
                            input.directory === undefined
                              ? `Parent session not found: ${context.sessionID}`
                              : `Subagent directory is unavailable: ${input.directory}`,
                          error,
                        }),
                    ),
                  ))

              yield* context.progress({ sessionID: child.id, status: "running" })

              // Standard prompt admission outside the job: Job.start joining a running child skips
              // its run effect, and the default wake starts an idle child or steers a running one.
              yield* sessions
                .prompt({
                  sessionID: child.id,
                  text:
                    existing === undefined
                      ? ["You are a subagent spawned by another session.", input.prompt, ABORT_POLICY].join("\n\n")
                      : input.prompt.includes(ABORT_POLICY)
                        ? input.prompt
                        : [input.prompt, ABORT_POLICY].join("\n\n"),
                  ...(existing === undefined ? { resume: false } : {}),
                })
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Failed to prompt subagent: ${child.id}`, error }),
                  ),
                )

              const recovery = {
                kind: "subagent" as const,
                parentSessionID: context.sessionID,
                childSessionID: child.id,
                agent: agent.name,
                description: input.description,
              }

              yield* subagents.start(recovery)
              yield* subagents.background(recovery)
              return backgroundResult(child.id)
            }).pipe(
              Effect.map((output) => ({
                output,
                content: output.output,
                metadata: { sessionID: output.sessionID, status: output.status },
              })),
            ),
        })
        draft.add({
          name: "subagent_output",
          options: { codemode: false, permission: name },
          description: "Recover a child session's latest completed response after context loss.",
          input: InspectInput,
          output: InspectOutput,
          execute: (input, context) =>
            Effect.gen(function* () {
              const child = yield* ownChild(context.sessionID, input.sessionID)
              if (!child)
                return inspectResult(`Cannot read subagent ${input.sessionID}: it was not launched from this session.`)
              const active = yield* sessions.active
              const output = yield* latestAssistantText(input.sessionID).pipe(Effect.orElseSucceed(() => NO_TEXT))
              return inspectResult(
                [
                  `subagent ${input.sessionID} (${child.title ?? "subagent"})`,
                  active.has(input.sessionID)
                    ? "Still running; the latest completed response follows."
                    : "Not running.",
                  "",
                  output,
                ].join("\n"),
              )
            }),
        })
        draft.add({
          name: "subagent_interrupt",
          options: { codemode: false, permission: name },
          description: `Interrupt a direct child's execution and cancel its background shells without a model round-trip. Wait up to ${Duration.toSeconds(INTERRUPT_SETTLEMENT)} seconds for cleanup, then report whether it stopped or is still stopping. Continue its conversation later with subagent.`,
          input: InspectInput,
          output: InspectOutput,
          execute: (input, context) =>
            Effect.gen(function* () {
              const child = yield* ownChild(context.sessionID, input.sessionID)
              if (!child)
                return inspectResult(
                  `Cannot interrupt subagent ${input.sessionID}: it was not launched from this session.`,
                )
              // The child's own shells go first: a result arriving after the stop would otherwise wake it, and
              // the cancelled notice its parent is owed waits for child-owned work to drain.
              const shells = (yield* jobs.running(child.id)).filter((job) => job.type === "shell")
              yield* Effect.forEach(shells, (job) => jobs.cancel(job.id), { discard: true })
              // Interruption acknowledges before cleanup settles; report which of the two the parent has.
              const interrupted = yield* sessions.interrupt(child.id).pipe(Effect.orElseSucceed(() => false))
              const settled = interrupted
                ? yield* sessions.wait(child.id).pipe(
                    Effect.timeout(INTERRUPT_SETTLEMENT),
                    Effect.as(true),
                    Effect.orElseSucceed(() => false),
                  )
                : true
              return inspectResult(
                [
                  `subagent ${child.id} (${child.title ?? "subagent"})`,
                  interrupted
                    ? settled
                      ? "Interrupted; its turn has stopped."
                      : "Interrupt accepted; its turn is still stopping."
                    : "Not running; nothing to interrupt.",
                  ...(shells.length > 0
                    ? [
                        `Cancelled ${shells.length} background shell${shells.length === 1 ? "" : "s"} it launched: ${shells.map((job) => job.title ?? job.id).join("; ")}`,
                      ]
                    : []),
                  ...(interrupted ? ['A <subagent state="cancelled"> notice follows once its cleanup settles.'] : []),
                  `Its conversation is intact. Continue it with subagent sessionID=${child.id} and new instructions; it does not resume on its own.`,
                ].join("\n"),
              )
            }),
        })
        draft.add({
          name: "subagent_list",
          options: { codemode: false, permission: name },
          description:
            "Recover child session IDs after context loss. Lists active subagents first, then recent inactive subagents launched from this session.",
          input: Schema.Struct({}),
          output: InspectOutput,
          execute: (_input, context) =>
            Effect.gen(function* () {
              const [children, active] = yield* Effect.all([
                sessions.list({ parentID: context.sessionID }),
                sessions.active,
              ])
              if (children.data.length === 0) return inspectResult("No subagents have been launched from this session.")
              const rows = (child: SessionSchema.Info) => {
                const state = active.has(child.id)
                  ? "running"
                  : child.outcome === "succeeded"
                    ? "completed"
                    : child.outcome === "failed"
                      ? "failed"
                      : child.outcome === "interrupted"
                        ? "cancelled"
                        : "not running; terminal outcome unavailable"
                return `- ${child.id} -- ${child.title ?? "subagent"}${child.agent ? ` (${child.agent})` : ""}, ${state}`
              }
              const running = children.data.filter((child) => active.has(child.id))
              const inactive = children.data.filter((child) => !active.has(child.id))
              const recent = inactive.slice(0, Math.max(0, MAX_LISTED_SUBAGENTS - running.length))
              const hidden = inactive.length - recent.length
              return inspectResult(
                [
                  "Subagents launched from this session:",
                  ...(running.length > 0 ? ["", "Active:", ...running.map(rows)] : []),
                  ...(recent.length > 0 ? ["", "Recent:", ...recent.map(rows)] : []),
                  ...(hidden > 0 ? ["", `${hidden} more inactive subagent${hidden === 1 ? "" : "s"} not shown.`] : []),
                ].join("\n"),
              )
            }),
        })
      })
      .pipe(Effect.orDie)

    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const tool = event.tools[name]
        if (!tool) return
        const selected = yield* agents.resolve(event.agent)
        if (!selected) return
        const available = (yield* agents.list())
          .filter(
            (agent) =>
              agent.mode !== "primary" &&
              !agent.hidden &&
              Permission.evaluate(name, agent.id, selected.permissions).effect !== "deny",
          )
          .toSorted((a, b) => a.id.localeCompare(b.id))
        if (available.length === 0) return
        tool.description = [
          tool.description,
          "",
          "Available subagents:",
          ...available.map(
            (agent) =>
              `- ${agent.id}: ${agent.description ?? "This subagent should only be called when explicitly requested."}`,
          ),
        ].join("\n")
      }),
    )
  }),
}
