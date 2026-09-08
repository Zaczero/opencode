import { describe, expect } from "bun:test"
import { Job } from "@opencode-ai/core/job"
import { KV } from "@opencode-ai/core/kv"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Job.node, KV.node])))

describe("Job", () => {
  it.live("delivers completion after the observer's dispatch scope closes", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const output = yield* Deferred.make<string>()
      const delivered = yield* Deferred.make<Job.Info>()
      const job = yield* jobs.start({ type: "shell", run: Deferred.await(output) })
      yield* jobs.observe(job.id, (info) => Deferred.succeed(delivered, info).pipe(Effect.asVoid)).pipe(Effect.scoped)

      yield* Deferred.succeed(output, "finished after dispatch")
      expect(yield* Deferred.await(delivered)).toMatchObject({
        id: job.id,
        status: "completed",
        output: "finished after dispatch",
      })
    }),
  )

  it.live("persists shell interruption before its completion observer acknowledges it", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const interrupted = yield* Deferred.make<void>()
      const owner = SessionSchema.ID.make("ses_interrupted_shell")
      const job = yield* jobs.start({
        type: "shell",
        metadata: { sessionID: owner },
        recovery: { kind: "shell", sessionID: owner, shellID: "sh_interrupted", command: "build" },
        run: Deferred.await(interrupted).pipe(Effect.andThen(Effect.interrupt)),
      })
      const background = yield* jobs.background(job.id)
      if (!background?.notificationID) throw new Error("Missing notification identity")
      yield* Deferred.succeed(interrupted, undefined)
      expect((yield* jobs.wait({ id: job.id })).info?.status).toBe("cancelled")
      expect(yield* jobs.pendingBackground).toMatchObject([{ id: job.id, status: "cancelled" }])
      yield* jobs.completeBackground(background.notificationID)
      expect(yield* jobs.activeSessions).toEqual(new Set())
      expect(yield* jobs.awaitOwned(owner)).toBe(false)
    }),
  )

  it.live("keeps owned work pending until its completion result is delivered", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const owner = SessionSchema.ID.make("ses_delivery_owner")
      const exited = yield* Deferred.make<string>()
      const job = yield* jobs.start({
        type: "shell",
        metadata: { sessionID: owner },
        recovery: { kind: "shell", sessionID: owner, shellID: "sh_delivery", command: "build" },
        run: Deferred.await(exited),
      })
      const background = yield* jobs.background(job.id)
      if (!background?.notificationID) return yield* Effect.die("Missing notification identity")
      const delivered = yield* Deferred.make<boolean>()
      const waiter = yield* jobs.awaitOwned(owner).pipe(
        Effect.tap((waited) => Deferred.succeed(delivered, waited)),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* Deferred.succeed(exited, "build finished")
      yield* jobs.wait({ id: job.id })
      expect(yield* jobs.running(owner)).toEqual([])
      expect(yield* Deferred.isDone(delivered)).toBe(false)
      expect(yield* jobs.activeSessions).toEqual(new Set([owner]))
      yield* jobs.completeBackground(background.notificationID)
      expect(yield* Fiber.join(waiter)).toBe(true)
      expect(yield* jobs.awaitOwned(owner)).toBe(false)
      expect(yield* jobs.activeSessions).toEqual(new Set())
    }),
  )

  it.live("tracks process-local work through explicit observation", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        metadata: { durable: false },
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect(job).toMatchObject({ type: "test", status: "running", metadata: { durable: false } })
      expect(yield* jobs.wait({ id: job.id, timeout: 0 })).toMatchObject({
        timedOut: true,
        info: { status: "running" },
      })

      yield* Deferred.succeed(latch, undefined)
      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "done" },
      })
    }),
  )

  it.live("publishes jobs before starting immediately settling work", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) => {
        const id = `job_immediate_start_${index}`
        return Effect.gen(function* () {
          const job = yield* jobs.start({
            id,
            type: "test",
            run: jobs
              .get(id)
              .pipe(
                Effect.flatMap((info) =>
                  info?.status === "running"
                    ? Effect.succeed(`done-${index}`)
                    : Effect.fail("job started before publish"),
                ),
              ),
          })

          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `done-${index}` },
          })
        })
      })
    }),
  )

  it.live("reuses running work when started again with the same ID", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const output = yield* Deferred.make<string>()
      const job = yield* jobs.start({ id: "job_reused", type: "test", run: Deferred.await(output) })

      expect(
        yield* jobs.start({ id: job.id, type: "duplicate", run: Effect.die("Duplicate work must not run") }),
      ).toEqual(job)

      yield* Deferred.succeed(output, "original output")
      expect((yield* jobs.wait({ id: job.id })).info).toMatchObject({
        type: "test",
        status: "completed",
        output: "original output",
      })
    }),
  )

  it.live("ignores an obsolete callback after a cancellation waiter starts a same-ID replacement", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const callback = yield* Deferred.make<() => void>()
      const output = yield* Deferred.make<string>()
      const finalized = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        id: "job_replaced",
        type: "test",
        run: Effect.callback<string>((resume) => {
          Deferred.doneUnsafe(
            callback,
            Effect.succeed(() => resume(Effect.succeed("obsolete output"))),
          )
        }),
      })
      const complete = yield* Deferred.await(callback)
      // Cancellation wakes waiters before closing the old scope, allowing the old callback to race replacement.
      const replacement = yield* jobs.wait({ id: job.id }).pipe(
        Effect.tap((result) => Effect.sync(() => expect(result.info?.status).toBe("cancelled"))),
        Effect.andThen(
          jobs.start({
            id: job.id,
            type: "replacement",
            run: Deferred.await(output).pipe(Effect.ensuring(Deferred.succeed(finalized, undefined))),
          }),
        ),
        Effect.andThen(Effect.sync(complete)),
        Effect.forkChild({ startImmediately: true }),
      )

      yield* jobs.cancel(job.id)
      yield* Fiber.join(replacement)
      expect(yield* jobs.get(job.id)).toMatchObject({ type: "replacement", status: "running" })
      expect(yield* Deferred.isDone(finalized)).toBe(false)

      yield* Deferred.succeed(output, "replacement output")
      expect((yield* jobs.wait({ id: job.id })).info).toMatchObject({
        type: "replacement",
        status: "completed",
        output: "replacement output",
      })
      expect(yield* Deferred.isDone(finalized)).toBe(true)
    }),
  )

  it.live("restarts a terminal job under the same identifier", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const id = "job_restarted"
      const owner = SessionSchema.ID.make("ses_restarted")
      const first = yield* jobs.start({ id, type: "test", run: Effect.succeed("first") })
      expect(yield* jobs.wait({ id: first.id })).toMatchObject({ info: { status: "completed", output: "first" } })

      const latch = yield* Deferred.make<void>()
      const second = yield* jobs.start({
        id,
        type: "test",
        metadata: { sessionID: owner },
        run: Deferred.await(latch).pipe(Effect.as("second")),
      })
      expect(yield* jobs.get(id)).toMatchObject({ status: "running" })
      expect(yield* jobs.activeSessions).toEqual(new Set([owner]))

      yield* Deferred.succeed(latch, undefined)
      expect(yield* jobs.wait({ id: second.id })).toMatchObject({ info: { status: "completed", output: "second" } })
      expect(yield* jobs.activeSessions).toEqual(new Set())
    }),
  )

  it.live("returns finished from a blocking wait when completion wins", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({ type: "test", run: Deferred.await(latch).pipe(Effect.as("done")) })
      const waiting = yield* jobs
        .block({ id: job.id, sessionID: SessionSchema.ID.make("ses_parent") })
        .pipe(Effect.forkIn(yield* Scope.Scope, { startImmediately: true }))

      yield* Deferred.succeed(latch, undefined)

      expect(yield* Fiber.join(waiting)).toMatchObject({
        type: "finished",
        info: { status: "completed", output: "done" },
      })
      expect(yield* jobs.background(job.id)).toBeUndefined()
    }),
  )

  // A session that owns running work has not finished, however idle its own execution looks. This is what
  // lets a subagent's completion wait for the shell it will be woken by instead of reporting ahead of it.
  it.live("reports the jobs still running on behalf of a session", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const owner = SessionSchema.ID.make("ses_owner")
      const other = SessionSchema.ID.make("ses_other")
      const latch = yield* Deferred.make<void>()
      const mine = yield* jobs.start({
        type: "shell",
        metadata: { sessionID: owner },
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })
      yield* jobs.start({
        type: "shell",
        metadata: { sessionID: other },
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })
      const settled = yield* jobs.start({ type: "shell", metadata: { sessionID: owner }, run: Effect.succeed("done") })
      yield* jobs.wait({ id: settled.id })

      expect((yield* jobs.running(owner)).map((job) => job.id)).toEqual([mine.id])
      expect(yield* jobs.running(SessionSchema.ID.make("ses_none"))).toEqual([])
      expect(yield* jobs.activeSessions).toEqual(new Set([owner, other]))

      yield* Deferred.succeed(latch, undefined)
      yield* jobs.wait({ id: mine.id })
      expect(yield* jobs.running(owner)).toEqual([])
      expect(yield* jobs.activeSessions).toEqual(new Set())
    }),
  )

  it.live("returns backgrounded from a blocking wait when background wins", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({ type: "test", run: Deferred.await(latch).pipe(Effect.as("done")) })
      const waiting = yield* jobs
        .block({ id: job.id, sessionID: SessionSchema.ID.make("ses_parent") })
        .pipe(Effect.forkIn(yield* Scope.Scope, { startImmediately: true }))

      expect(yield* jobs.background(job.id)).toMatchObject({ id: job.id, status: "running" })
      expect(yield* Fiber.join(waiting)).toMatchObject({
        type: "backgrounded",
        info: { id: job.id, status: "running" },
      })

      yield* Deferred.succeed(latch, undefined)
      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "done" },
      })
    }),
  )

  it.live("backgrounds only jobs actively blocking a session", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const parent = SessionSchema.ID.make("ses_parent")
      const other = SessionSchema.ID.make("ses_other")
      const latch = yield* Deferred.make<void>()
      const first = yield* jobs.start({
        id: "job_first",
        type: "test",
        run: Deferred.await(latch).pipe(Effect.as("first")),
      })
      const second = yield* jobs.start({
        id: "job_second",
        type: "test",
        run: Deferred.await(latch).pipe(Effect.as("second")),
      })
      const third = yield* jobs.start({
        id: "job_third",
        type: "other",
        run: Deferred.await(latch).pipe(Effect.as("third")),
      })
      const scope = yield* Scope.Scope
      const firstWait = yield* jobs
        .block({ id: first.id, sessionID: parent })
        .pipe(Effect.forkIn(scope, { startImmediately: true }))
      const secondWait = yield* jobs
        .block({ id: second.id, sessionID: other })
        .pipe(Effect.forkIn(scope, { startImmediately: true }))
      const thirdWait = yield* jobs
        .block({ id: third.id, sessionID: parent })
        .pipe(Effect.forkIn(scope, { startImmediately: true }))

      expect(yield* jobs.backgroundAll({ sessionID: parent, type: "test" })).toMatchObject([{ id: first.id }])
      expect(yield* Fiber.join(firstWait)).toMatchObject({ type: "backgrounded", info: { id: first.id } })

      yield* Deferred.succeed(latch, undefined)
      expect(yield* Fiber.join(secondWait)).toMatchObject({ type: "finished", info: { id: second.id } })
      expect(yield* Fiber.join(thirdWait)).toMatchObject({ type: "finished", info: { id: third.id } })
    }),
  )

  it.live("retains background ownership and terminal output until notification acknowledgment", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const latch = yield* Deferred.make<void>()
      const recovery = {
        kind: "shell" as const,
        sessionID: SessionSchema.ID.make("ses_background_shell"),
        shellID: "shell_background",
        command: "echo done",
      }
      const job = yield* jobs.start({ type: "shell", recovery, run: Deferred.await(latch).pipe(Effect.as("done")) })

      expect((yield* jobs.pendingBackground).find((item) => item.id === job.id)).toBeUndefined()
      const background = yield* jobs.background(job.id)

      const running = (yield* jobs.pendingBackground).find((item) => item.id === job.id)
      expect(running).toMatchObject({ id: job.id, recovery, status: "running" })
      expect(running?.notificationID).toStartWith("msg_")
      expect(background?.notificationID).toBe(running?.notificationID)

      yield* Deferred.succeed(latch, undefined)
      yield* jobs.wait({ id: job.id })

      const completed = (yield* jobs.pendingBackground).find((item) => item.id === job.id)
      expect(completed).toMatchObject({
        id: job.id,
        notificationID: running?.notificationID,
        recovery,
        status: "completed",
        output: "done",
      })
      if (!completed) return yield* Effect.die("background marker missing")

      yield* jobs.completeBackground(completed.notificationID)
      expect((yield* jobs.pendingBackground).find((item) => item.id === job.id)).toBeUndefined()
    }),
  )

  it.live("persists backgroundAll ownership before releasing a blocked subagent", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const parentSessionID = SessionSchema.ID.make("ses_background_parent")
      const latch = yield* Deferred.make<void>()
      const recovery = {
        kind: "subagent" as const,
        parentSessionID,
        childSessionID: SessionSchema.ID.make("ses_background_child"),
        agent: "explore",
        description: "Explore background recovery",
      }
      const job = yield* jobs.start({ type: "subagent", recovery, run: Deferred.await(latch).pipe(Effect.as("done")) })
      const waiting = yield* jobs
        .block({ id: job.id, sessionID: parentSessionID })
        .pipe(Effect.forkIn(yield* Scope.Scope, { startImmediately: true }))

      yield* jobs.backgroundAll({ sessionID: parentSessionID })
      expect(yield* Fiber.join(waiting)).toMatchObject({ type: "backgrounded", info: { id: job.id } })

      const marker = (yield* jobs.pendingBackground).find((item) => item.id === job.id)
      expect(marker).toMatchObject({ id: job.id, recovery, status: "running" })
      if (!marker) return yield* Effect.die("background marker missing")

      yield* jobs.cancel(job.id)
      expect((yield* jobs.pendingBackground).find((item) => item.id === job.id)).toMatchObject({
        notificationID: marker.notificationID,
        status: "cancelled",
      })
      yield* jobs.completeBackground(marker.notificationID)
    }),
  )

  it.live("retains terminal errors for recovery until notification acknowledgment", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "shell",
        recovery: {
          kind: "shell",
          sessionID: SessionSchema.ID.make("ses_background_error"),
          shellID: "shell_error",
          command: "exit 1",
        },
        run: Deferred.await(latch).pipe(Effect.andThen(Effect.fail(new Error("shell failed")))),
      })

      yield* jobs.background(job.id)
      yield* Deferred.succeed(latch, undefined)
      yield* jobs.wait({ id: job.id })

      const marker = (yield* jobs.pendingBackground).find((item) => item.id === job.id)
      expect(marker).toMatchObject({ id: job.id, status: "error", error: "shell failed" })
      if (!marker) return yield* Effect.die("background marker missing")
      yield* jobs.completeBackground(marker.notificationID)
    }),
  )

  it.live("durably backgrounds recoverable work that has already failed", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const job = yield* jobs.start({
        type: "shell",
        recovery: {
          kind: "shell",
          sessionID: SessionSchema.ID.make("ses_immediate_error"),
          shellID: "shell_immediate_error",
          command: "exit 1",
        },
        run: Effect.fail(new Error("shell failed")),
      })
      expect((yield* jobs.wait({ id: job.id })).info?.status).toBe("error")

      const background = yield* jobs.background(job.id)
      expect(background?.notificationID).toStartWith("msg_")
      expect(yield* jobs.pendingBackground).toMatchObject([
        { id: job.id, notificationID: background?.notificationID, status: "error", error: "shell failed" },
      ])
    }),
  )

  it.live("recovers a background marker after its process-local registry closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const previous = yield* Job.make.pipe(Scope.provide(scope))
      const job = yield* previous.start({
        type: "shell",
        recovery: {
          kind: "shell",
          sessionID: SessionSchema.ID.make("ses_background_restart"),
          shellID: "shell_restart",
          command: "sleep 60",
        },
        run: Effect.never,
      })
      yield* previous.background(job.id)
      yield* Scope.close(scope, Exit.void)

      const current = yield* Job.make
      const marker = (yield* current.pendingBackground).find((item) => item.id === job.id)
      expect(marker).toMatchObject({ id: job.id, status: "running" })
      if (!marker) return yield* Effect.die("background marker missing")
      yield* current.completeBackground(marker.notificationID)
    }),
  )

  it.live("preserves running background ownership when its work is interrupted", () =>
    Effect.gen(function* () {
      const jobs = yield* Job.Service
      const interrupted = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "subagent",
        recovery: {
          kind: "subagent",
          parentSessionID: SessionSchema.ID.make("ses_interrupted_parent"),
          childSessionID: SessionSchema.ID.make("ses_interrupted_child"),
          agent: "explore",
          description: "Continue after shutdown",
        },
        run: Deferred.await(interrupted).pipe(Effect.andThen(Effect.interrupt)),
      })
      yield* jobs.background(job.id)
      yield* Deferred.succeed(interrupted, undefined)
      yield* jobs.wait({ id: job.id })

      const marker = (yield* jobs.pendingBackground).find((item) => item.id === job.id)
      expect(marker).toMatchObject({ id: job.id, status: "running" })
      if (!marker) return yield* Effect.die("background marker missing")
      yield* jobs.completeBackground(marker.notificationID)
    }),
  )

  it.live("interrupts live work without promising settlement after the owning process-local scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const interrupted = yield* Deferred.make<void>()
      const jobs = yield* Job.make.pipe(Scope.provide(scope))
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })

      yield* Scope.close(scope, Exit.void)

      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      // The abandoned in-memory registry is not a durable observation channel.
      expect((yield* jobs.get(job.id))?.status).toBe("running")
    }),
  )
})
