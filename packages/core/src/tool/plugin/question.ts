export * as QuestionTool from "./question.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai"
import { Effect, Schema } from "effect"
import { Form } from "../../form.js"
import { Permission } from "../../permission.js"
import type { SessionSchema } from "../../session/schema.js"
import { Question } from "@opencode/schema/question"

export const name = "question"

export const description = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- A "Type your own answer" option is added automatically; don't include a separate option for free form answers
- Set \`multiple: true\` to allow selecting more than one option
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label`

export const Input = Schema.Struct({
  questions: Schema.Array(Question.Prompt).check(Schema.isNonEmpty()).annotate({ description: "Questions to ask" }),
})

export const Output = Schema.Struct({
  answers: Schema.Array(Question.Answer),
})
export type Output = typeof Output.Type

export class CancelledError extends Schema.TaggedError<CancelledError>()("QuestionTool.CancelledError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export const toModelContent = (questions: ReadonlyArray<Question.Prompt>, answers: ReadonlyArray<Question.Answer>) => {
  const formatted = questions
    .map(
      (question, index) =>
        `"${question.question}"="${answers[index]?.length ? answers[index].join(", ") : "Unanswered"}"`,
    )
    .join(", ")
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}

/** The user talks to the root session; a subagent's open decision is an abort condition it reports upward. */
export const CHILD_REFUSAL =
  "Only the root session can ask the user. Report the decision you need to your parent instead of guessing."

export const Plugin = {
  id: "opencode.tool.question",
  effect: Effect.fn("QuestionTool.Plugin")(function* (ctx: Context) {
    const forms = yield* Form.Service
    const permission = yield* Permission.Service
    // Parentage is durable session state, so a child never sees the tool whatever its agent's permissions say.
    const isRoot = (sessionID: SessionSchema.ID) =>
      ctx.session.get({ sessionID }).pipe(
        Effect.map((session) => session.parentID === undefined),
        Effect.orElseSucceed(() => false),
      )

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              if (!(yield* isRoot(context.sessionID))) return yield* new ToolFailure({ message: CHILD_REFUSAL })
              yield* permission
                .assert({
                  action: "question",
                  resources: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: "Permission denied: question", error })))
              const state = yield* forms
                .ask({
                  sessionID: context.sessionID,
                  title: "Questions",
                  metadata: {
                    kind: "question",
                    tool: { messageID: context.messageID, id: context.id },
                  },
                  fields: [
                    toField(input.questions[0], 0),
                    ...input.questions.slice(1).map((question, index) => toField(question, index + 1)),
                  ],
                })
                .pipe(Effect.orDie)
              // Deliberate defect tunnel (see Permission.assert): a dismissal must dodge
              // leaf `mapError` blankets so it never becomes model-facing tool output; it
              // resurfaces as a typed failure at SessionModelRequest.executeTool.
              if (state.status === "cancelled") return yield* Effect.die(new CancelledError())
              const output = {
                answers: input.questions.map((_, index): Question.Answer => {
                  const value = state.answer[`q${index}`]
                  if (value === undefined) return []
                  if (typeof value === "object") return Array.from(value)
                  return [String(value)]
                }),
              }
              return {
                output,
                content: toModelContent(input.questions, output.answers),
                metadata: { answers: output.answers },
              }
            }),
        }),
      )
      .pipe(Effect.orDie)

    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        if (!event.tools[name]) return
        if (!(yield* isRoot(event.sessionID))) delete event.tools[name]
      }),
    )
  }),
}

function toField(question: Question.Prompt, index: number): Form.Field {
  return {
    key: `q${index}`,
    title: question.header,
    description: question.question,
    type: question.multiple === true ? "multiselect" : "string",
    options: question.options.map((option) => ({
      value: option.label,
      label: option.label,
      description: option.description,
    })),
    custom: true,
  }
}
