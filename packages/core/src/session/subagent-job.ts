export * as SubagentJob from "./subagent-job.js"

import { Effect, Scope } from "effect"
import { Job } from "../job.js"
import { Session } from "../session.js"
import { SubagentCompletion } from "./subagent-completion.js"

type Recovery = Extract<Job.Recovery, { kind: "subagent" }>

interface Runner {
  start: (recovery: Recovery) => Effect.Effect<Job.Info>
  background: (recovery: Recovery) => Effect.Effect<void>
  notify: (recovery: Recovery, startedAt: number) => Effect.Effect<void>
}

export const make: Effect.Effect<Runner, never, Session.Service | Job.Service | Scope.Scope> = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const jobs = yield* Job.Service
  const scope = yield* Scope.Scope
  // One observer per job generation, including continuations of the same child.
  const notifications = new Set<string>()

  const notify = Effect.fn("SubagentJob.notify")(function* (recovery: Recovery, startedAt: number) {
    const key = `${recovery.childSessionID}:${startedAt}`
    if (notifications.has(key)) return
    notifications.add(key)
    yield* Effect.gen(function* () {
      let info = (yield* jobs.wait({ id: recovery.childSessionID })).info
      while (info && info.status !== "running") {
        const outstanding = yield* jobs.running(recovery.childSessionID)
        if (outstanding.length === 0) break
        yield* Effect.forEach(outstanding, (job) => jobs.wait({ id: job.id }), { discard: true })
        yield* sessions.wait(recovery.childSessionID)
        info = (yield* jobs.wait({ id: recovery.childSessionID })).info
      }
      if (info?.status === "completed") {
        const messages = yield* sessions.messages({ sessionID: recovery.childSessionID, order: "desc", limit: 20 })
        info = { ...info, output: SubagentCompletion.text(messages.find((message) =>
          message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
        )) }
      }
      if (info) yield* SubagentCompletion.deliver(sessions, jobs, { ...info, recovery })
    }).pipe(
      Effect.ensuring(Effect.sync(() => notifications.delete(key))),
      Effect.forkIn(scope, { startImmediately: true }),
    )
  })

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
      const info = yield* jobs.background(recovery.childSessionID)
      if (info) yield* notify(recovery, info.started_at)
    }),
    notify,
  }
})
