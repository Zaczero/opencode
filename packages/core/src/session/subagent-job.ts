export * as SubagentJob from "./subagent-job.js"

import { Effect } from "effect"
import { Job } from "../job.js"
import { Session } from "../session.js"
import { SubagentCompletion } from "./subagent-completion.js"

type Recovery = Extract<Job.Recovery, { kind: "subagent" }>

interface Runner {
  start: (recovery: Recovery) => Effect.Effect<Job.Info>
  background: (recovery: Recovery) => Effect.Effect<void>
}

export const make: Effect.Effect<Runner, never, Session.Service | Job.Service> = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const jobs = yield* Job.Service

  return {
    start: (recovery: Recovery) =>
      jobs.start({
        id: recovery.childSessionID,
        type: "subagent",
        title: recovery.description,
        metadata: { sessionID: recovery.parentSessionID, childID: recovery.childSessionID },
        recovery,
        run: Effect.gen(function* () {
          yield* sessions.resume(recovery.childSessionID)
          const messages = yield* sessions.messages({ sessionID: recovery.childSessionID, order: "desc", limit: 20 })
          const assistant = messages.find(
            (message) =>
              message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
          )
          return SubagentCompletion.text(assistant)
        }),
      }),
    background: Effect.fn("SubagentJob.background")(function* (recovery: Recovery) {
      yield* jobs.background(recovery.childSessionID)
    }),
  }
})
