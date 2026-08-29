export * as SubagentTool from "./subagent.js"

import { ToolFailure } from "@opencode-ai/ai"
import type { Context as PluginContext } from "@opencode-ai/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { PluginRuntime } from "../../plugin/runtime.js"
import { Permission } from "../../permission.js"
import { SessionSchema } from "../../session/schema.js"

export const name = "subagent"

const NO_TEXT = "Subagent completed without a text response."
const MAX_LISTED_SUBAGENTS = 30
const ABORT_POLICY =
  "ABORT CONDITION: stop and report instead of working around it when the task is broken rather than merely hard -- when finishing would mean building on something that is not true. Say what is incoherent, give the evidence, and name what would unblock you: a correction, a decision that is not yours, or more reasoning than you have. Halting is free here. This session is resumable, your report is read in full, and the work resumes from where you stopped. A diff built on a broken premise is the outcome that cannot be recovered. This is not licence to stop on difficulty. Hard, long, unfamiliar and tedious work is yours to finish. Quietly narrowing the task to something you can complete, or shipping a lesser mechanism without saying so, is the failure this prevents."
const backgroundResult = (sessionID: SessionSchema.ID) => ({
  sessionID,
  status: "running" as const,
  output: [
    `The subagent is working in the background (sessionID: ${sessionID}). You will be notified automatically when it finishes.`,
    "DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using.",
    "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
  ].join("\n"),
})

export const Input = Schema.Struct({
  agent: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  description: Schema.String.annotate({ description: "A short 3-5 word label for the task, displayed to the user" }),
  prompt: Schema.String.annotate({ description: "The task for the subagent to perform" }),
  sessionID: Schema.optionalKey(SessionSchema.ID).annotate({
    description:
      "Continue a specific previous subagent conversation by passing its sessionID. Calls without a sessionID start a new conversation.",
  }),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literal("running"),
  output: Schema.String,
})

const InspectInput = Schema.Struct({ sessionID: SessionSchema.ID })
const InspectOutput = Schema.Struct({ output: Schema.String })
const inspectResult = (output: string) => ({ output: { output }, content: output })
export const description = [
  "Dispatch an agent into a child session to carry out a task.",
  "A new child inherits nothing from this conversation; its prompt carries every fact it needs.",
  "Every dispatch runs in the background and returns immediately. You are notified when it finishes.",
  "Passing sessionID reaches an existing child, including one still running. Use it to steer work in flight instead of dispatching duplicate work.",
  "To stop a child, tell it to stop now and abort the work.",
].join("\n")

export const Plugin = {
  id: "opencode.tool.subagent",
  effect: Effect.fn("SubagentTool.Plugin")(function* (ctx: PluginContext) {
    const runtime = yield* PluginRuntime.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    // Concatenate the child's final completed assistant text. Distinguishes "completed with no
    // text" (generic string) from "failed" (the run effect fails, surfaced as a job error).
    const latestAssistantText = Effect.fn("SubagentTool.latestAssistantText")(function* (sessionID: SessionSchema.ID) {
      const messages = yield* runtime.session.messages({ sessionID, order: "desc", limit: 20 })
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
      const child = yield* runtime.session.get(childID).pipe(Effect.option)
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
              const parent = yield* runtime.session
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
                current = yield* runtime.session
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
                  : yield* runtime.session
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
                yield* runtime.session.switchAgent({ sessionID: existing.id, agent: agent.id }).pipe(
                  Effect.andThen(
                    agent.model === undefined
                      ? Effect.void
                      : runtime.session.switchModel({ sessionID: existing.id, model: agent.model }),
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
                (yield* runtime.session
                  .create({
                    parentID: context.sessionID,
                    title: input.description,
                    agent: Agent.ID.make(input.agent),
                    model,
                  })
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                    ),
                  ))

               yield* context.progress({ sessionID: child.id, status: "running" })

              // Standard prompt admission outside the job: Job.start joining a running child skips
              // its run effect, and the default wake starts an idle child or steers a running one.
              yield* runtime.session
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

              const info = yield* runtime.job.start({
                id: child.id,
                type: name,
                title: input.description,
                // Records who owns this work, so the dispatching session counts as still running while it
                // is outstanding -- the same rule a background shell already obeys, and the one that keeps
                // a nested subagent from being reported done ahead of the child it spawned.
                metadata: { sessionID: context.sessionID, childID: child.id },
                recovery: {
                  kind: "subagent",
                  parentSessionID: context.sessionID,
                  childSessionID: child.id,
                  agent: agent.name,
                  description: input.description,
                },
                run: runtime.session.resume(child.id).pipe(Effect.andThen(latestAssistantText(child.id))),
              })

              yield* runtime.job.background(info.id)
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
        description: "Read a subagent's latest completed response after context loss.",
        input: InspectInput,
        output: InspectOutput,
        execute: (input, context) =>
          Effect.gen(function* () {
            const child = yield* ownChild(context.sessionID, input.sessionID)
            if (!child)
              return inspectResult(`Cannot read subagent ${input.sessionID}: it was not launched from this session.`)
            const active = yield* runtime.session.active
            const output = yield* latestAssistantText(input.sessionID).pipe(Effect.orElseSucceed(() => NO_TEXT))
            return inspectResult(
              [
                `subagent ${input.sessionID} (${child.title ?? "subagent"})`,
                active.has(input.sessionID) ? "Still running; the latest completed response follows." : "Not running.",
                "",
                output,
              ].join("\n"),
            )
          }),
      })
      draft.add({
        name: "subagent_list",
        options: { codemode: false, permission: name },
        description: "List active subagents first, then recent inactive subagents launched from this session.",
        input: Schema.Struct({}),
        output: InspectOutput,
        execute: (_input, context) =>
          Effect.gen(function* () {
            const [children, active] = yield* Effect.all([
              runtime.session.list({ parentID: context.sessionID }),
              runtime.session.active,
            ])
            if (children.data.length === 0)
              return inspectResult("No subagents have been launched from this session.")
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
