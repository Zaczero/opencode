export * as Job from "./job.js"

import { Array, Cause, Clock, Context, Deferred, Effect, Exit, Layer, Schema, Scope, SynchronizedRef } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Identifier } from "./id/id.js"
import { KV } from "./kv.js"
import { SessionMessage } from "./session/message.js"
import { SessionSchema } from "./session/schema.js"

const Background = Schema.Struct({
  id: Schema.String,
  notificationID: SessionMessage.ID,
  recovery: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("shell"),
      sessionID: SessionSchema.ID,
      shellID: Schema.String,
      command: Schema.String,
    }),
    Schema.Struct({
      kind: Schema.Literal("subagent"),
      parentSessionID: SessionSchema.ID,
      childSessionID: SessionSchema.ID,
      agent: Schema.String,
      description: Schema.String,
    }),
  ]),
  status: Schema.Literals(["running", "completed", "error", "cancelled"]),
  output: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
})

export type Background = typeof Background.Type
export type Recovery = Background["recovery"]
export type Status = Background["status"]

const decodeBackground = Schema.decodeUnknownResult(Background)
const backgroundPrefix = "job.background/"
const COMPLETED_LIMIT = 25

export type Info = {
  id: string
  type: string
  title?: string
  status: Status
  started_at: number
  completed_at?: number
  output?: string
  error?: string
  metadata?: Record<string, unknown>
  notificationID?: SessionMessage.ID
}

type Active = {
  info: Info
  done: Deferred.Deferred<Info>
  backgrounded: Deferred.Deferred<Info>
  scope: Scope.Closeable
  blockingSessions: Map<SessionSchema.ID, number>
  isBackgrounded: boolean
  consumed: boolean
  recovery?: Recovery
}

type State = {
  jobs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  backgroundListeners: Set<(background: Background) => Effect.Effect<void>>
  scope: Scope.Scope
}

type FinishResult = {
  info?: Info
  done?: Deferred.Deferred<Info>
  scope?: Scope.Closeable
  generation?: Scope.Closeable
  background?: Background
}

type BackgroundResult = {
  info?: Info
  backgrounded?: Deferred.Deferred<Info>
  background?: Background
}

type StartResult = { info: Info } | { info: Info; scope: Scope.Closeable }

type BlockWait = {
  done: Deferred.Deferred<Info>
  backgrounded: Deferred.Deferred<Info>
  generation: Scope.Closeable
}

type BlockStart =
  | { type: "missing" }
  | { type: "finished"; info: Info; generation: Scope.Closeable }
  | { type: "backgrounded"; info: Info }
  | { type: "wait"; wait: BlockWait }

export type StartInput = {
  id?: string
  type: string
  title?: string
  metadata?: Record<string, unknown>
  recovery?: Recovery
  notificationID?: SessionMessage.ID
  run: Effect.Effect<string, unknown>
}

export type WaitInput = {
  id: string
  timeout?: number
}

export type WaitResult = {
  info?: Info
  timedOut: boolean
}

export type BlockInput = {
  id: string
  sessionID: SessionSchema.ID
}

export type BlockResult = { type: "finished"; info: Info } | { type: "backgrounded"; info: Info }

export type BackgroundAllInput = {
  sessionID: SessionSchema.ID
  type?: string
}

export interface Interface {
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly start: (input: StartInput) => Effect.Effect<Info>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  /** Keep a completion observer alive independently of the dispatching Location. */
  readonly observe: (id: string, notify: (info: Info) => Effect.Effect<void, unknown>) => Effect.Effect<void>
  readonly block: (input: BlockInput) => Effect.Effect<BlockResult | undefined>
  readonly background: (id: string) => Effect.Effect<Info | undefined>
  readonly backgroundAll: (input: BackgroundAllInput) => Effect.Effect<Info[]>
  /**
   * Jobs still running on behalf of a session -- any background work it owns and will react to, whether
   * a shell or another subagent. A session with one of these outstanding has not finished, however idle
   * its own execution looks.
   */
  readonly running: (sessionID: SessionSchema.ID) => Effect.Effect<Info[]>
  /** Wait for currently owned processes and undelivered results; return whether any were present. */
  readonly awaitOwned: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  /** Sessions with work that is still running on their behalf. */
  readonly activeSessions: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly cancel: (id: string) => Effect.Effect<Info | undefined>
  /** Retire live work and undelivered notifications that reference a deleted Session. */
  readonly removeSession: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly pendingBackground: Effect.Effect<readonly Background[]>
  /** Observe terminal background subagents after their durable recovery record is written. */
  readonly onBackgroundSettled: (
    listener: (background: Background) => Effect.Effect<void>,
  ) => Effect.Effect<Effect.Effect<void>>
  readonly completeBackground: (notificationID: SessionMessage.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Job") {}

function snapshot(job: Active): Info {
  return {
    ...job.info,
    ...(job.info.metadata ? { metadata: { ...job.info.metadata } } : {}),
  }
}

function errorText(cause: Cause.Cause<unknown>) {
  const render = (error: Error): string => {
    const message = error.message || error.name || "Unknown error"
    if (!(error.cause instanceof Error)) return message
    const detail = render(error.cause)
    return detail === message || detail.startsWith(`${message}\n`) ? detail : `${message}\nCaused by: ${detail}`
  }
  return Cause.prettyErrors(cause).map(render).join("\n") || "Unknown error"
}

function incrementSession(input: Map<SessionSchema.ID, number>, sessionID: SessionSchema.ID) {
  return new Map(input).set(sessionID, (input.get(sessionID) ?? 0) + 1)
}

function decrementSession(input: Map<SessionSchema.ID, number>, sessionID: SessionSchema.ID) {
  const count = input.get(sessionID)
  if (count === undefined) return input
  const next = new Map(input)
  if (count <= 1) next.delete(sessionID)
  else next.set(sessionID, count - 1)
  return next
}

function backgroundRecord(job: Active): Background | undefined {
  if (!job.recovery || !job.info.notificationID) return undefined
  return {
    id: job.info.id,
    notificationID: job.info.notificationID,
    recovery: job.recovery,
    status: job.info.status,
    ...(job.info.output !== undefined ? { output: job.info.output } : {}),
    ...(job.info.error !== undefined ? { error: job.info.error } : {}),
  }
}

/**
 * Makes one scoped, process-local registry. Explicitly recoverable background
 * work also owns a durable notification marker until its notification is admitted.
 * Unconsumed results survive the start-to-wait handoff. Foreground block/cancel
 * and non-recoverable wait results enter a 25-entry consumed history. Recoverable
 * wait results stay available for background registration and acknowledgment.
 */
export const make = Effect.gen(function* () {
  const kv = yield* KV.Service
  const deliveries = new Map<SessionMessage.ID, { background: Background; done: Deferred.Deferred<void> }>()
  let after: string | undefined
  do {
    const page = yield* kv.scan({ prefix: backgroundPrefix, after })
    for (const background of Array.filterMap(page.entries, (entry) => decodeBackground(entry.value))) {
      deliveries.set(background.notificationID, { background, done: yield* Deferred.make<void>() })
    }
    after = page.next
  } while (after)
  const state: State = {
    jobs: yield* SynchronizedRef.make(new Map()),
    backgroundListeners: new Set(),
    scope: yield* Scope.Scope,
  }

  const consume = (id: string, generation: Scope.Closeable) =>
    SynchronizedRef.update(state.jobs, (jobs) => {
      const job = jobs.get(id)
      if (!job || job.scope !== generation || job.info.status === "running" || job.consumed) return jobs
      const next = new Map(jobs)
      // Order history by first consumption, not by start time or subsequent reads.
      next.delete(id)
      next.set(id, { ...job, consumed: true })
      const completed = [...next].filter(([, job]) => job.consumed && !job.info.notificationID)
      for (const [id] of completed.slice(0, -COMPLETED_LIMIT)) next.delete(id)
      return next
    })

  const notifyBackgroundSettled = Effect.fnUntraced(function* (background: Background) {
    yield* Effect.forEach(state.backgroundListeners, (listener) => listener(background), { discard: true })
  })

  const persistBackground = Effect.fnUntraced(function* (job: Active) {
    const background = backgroundRecord(job)
    if (!background) return undefined
    yield* kv.set(`${backgroundPrefix}${background.notificationID}`, background)
    const current = deliveries.get(background.notificationID)
    if (current) current.background = background
    else deliveries.set(background.notificationID, { background, done: yield* Deferred.make<void>() })
    return background
  })

  const settle = Effect.fnUntraced(function* (id: string, scope: Scope.Closeable, exit: Exit.Exit<string, unknown>) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [FinishResult, Map<string, Active>]> {
        const job = jobs.get(id)
        if (!job) return [{}, jobs]
        if (job.scope !== scope) return [{}, jobs]
        if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
        const status: Exclude<Status, "running"> = Exit.isSuccess(exit)
          ? "completed"
          : Cause.hasInterruptsOnly(exit.cause)
            ? "cancelled"
            : "error"
        const next = {
          ...job,
          blockingSessions: new Map<SessionSchema.ID, number>(),
          info: {
            ...job.info,
            status,
            completed_at,
            ...(Exit.isSuccess(exit) ? { output: exit.value } : {}),
            ...(Exit.isFailure(exit) ? { error: errorText(exit.cause) } : {}),
          },
        }
        const background =
          status === "cancelled" && job.recovery?.kind === "subagent" ? undefined : yield* persistBackground(next)
        return [
          {
            info: snapshot(next),
            done: job.done,
            scope: job.scope,
            ...(next.isBackgrounded && background ? { background } : {}),
          },
          new Map(jobs).set(id, next),
        ]
      }),
    )
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info)
    if (result.background?.recovery.kind === "subagent") yield* notifyBackgroundSettled(result.background)
    if (result.scope) {
      yield* Scope.close(result.scope, Exit.void).pipe(Effect.forkIn(state.scope, { startImmediately: true }))
    }
    return result.info
  })

  const get: Interface["get"] = Effect.fn("Job.get")(function* (id) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
    if (!job) return undefined
    return snapshot(job)
  })

  const start: Interface["start"] = Effect.fnUntraced(function* (input) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const id = input.id ?? Identifier.ascending("job")
        const started_at = yield* Clock.currentTimeMillis
        const done = yield* Deferred.make<Info>()
        const backgrounded = yield* Deferred.make<Info>()
        const result = yield* SynchronizedRef.modifyEffect(
          state.jobs,
          Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [StartResult, Map<string, Active>]> {
            const existing = jobs.get(id)
            if (existing?.info.status === "running") {
              return [{ info: snapshot(existing) }, jobs]
            }
            const scope = yield* Scope.fork(state.scope, "parallel")
            const job = {
              info: {
                id,
                type: input.type,
                title: input.title,
                status: "running" as const,
                started_at,
                metadata: input.metadata,
                ...(input.notificationID ? { notificationID: input.notificationID } : {}),
              },
              done,
              backgrounded,
              scope,
              blockingSessions: new Map<SessionSchema.ID, number>(),
              isBackgrounded: false,
              consumed: false,
              recovery: input.recovery,
            }
            return [{ info: snapshot(job), scope }, new Map(jobs).set(id, job)]
          }),
        )
        if ("scope" in result)
          yield* restore(input.run).pipe(
            Effect.exit,
            Effect.flatMap((exit) => settle(id, result.scope, exit)),
            Effect.asVoid,
            Effect.forkIn(result.scope, { startImmediately: true }),
          )
        return result.info
      }),
    )
  })

  const wait: Interface["wait"] = Effect.fn("Job.wait")(function* (input) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(input.id)
    if (!job) return { timedOut: false }
    return yield* Effect.gen(function* () {
      if (job.info.status !== "running") return { info: snapshot(job), timedOut: false }
      if (input.timeout === undefined) return { info: yield* Deferred.await(job.done), timedOut: false }
      if (input.timeout <= 0) return { info: snapshot(job), timedOut: true }
      const info = yield* Deferred.await(job.done).pipe(Effect.timeoutOption(input.timeout))
      if (info._tag === "Some") return { info: info.value, timedOut: false }
      return { info: snapshot(job), timedOut: true }
    }).pipe(
      // Recoverable wait -> background is a supported handoff, even after failure.
      Effect.tap((result) =>
        result.info.status === "running" || job.recovery ? Effect.void : consume(input.id, job.scope),
      ),
    )
  })

  const observe: Interface["observe"] = Effect.fn("Job.observe")(function* (id, notify) {
    yield* wait({ id }).pipe(
      Effect.flatMap((result) => (result.info ? notify(result.info) : Effect.void)),
      Effect.catchCause((cause) => Effect.logError("Failed to deliver job completion", { id, cause })),
      Effect.forkIn(state.scope, { startImmediately: true }),
    )
  })

  const removeBlock = Effect.fnUntraced(function* (input: BlockInput) {
    yield* SynchronizedRef.update(state.jobs, (jobs) => {
      const job = jobs.get(input.id)
      if (!job || job.info.status !== "running" || job.isBackgrounded) return jobs
      return new Map(jobs).set(input.id, {
        ...job,
        blockingSessions: decrementSession(job.blockingSessions, input.sessionID),
      })
    })
  })

  const block: Interface["block"] = Effect.fnUntraced(function* (input) {
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [BlockStart, Map<string, Active>] => {
      const job = jobs.get(input.id)
      if (!job) return [{ type: "missing" }, jobs]
      if (job.info.status !== "running") return [{ type: "finished", info: snapshot(job), generation: job.scope }, jobs]
      if (job.isBackgrounded) return [{ type: "backgrounded", info: snapshot(job) }, jobs]
      return [
        { type: "wait", wait: { done: job.done, backgrounded: job.backgrounded, generation: job.scope } },
        new Map(jobs).set(input.id, {
          ...job,
          blockingSessions: incrementSession(job.blockingSessions, input.sessionID),
        }),
      ]
    })
    if (result.type === "missing") return undefined
    if (result.type === "finished") {
      yield* consume(input.id, result.generation)
      return { type: "finished", info: result.info }
    }
    if (result.type === "backgrounded") return { type: "backgrounded", info: result.info }
    return yield* Effect.raceFirst(
      Deferred.await(result.wait.done).pipe(Effect.map((info) => ({ type: "finished" as const, info }))),
      Deferred.await(result.wait.backgrounded).pipe(Effect.map((info) => ({ type: "backgrounded" as const, info }))),
    ).pipe(
      Effect.tap((outcome) => (outcome.type === "finished" ? consume(input.id, result.wait.generation) : Effect.void)),
      Effect.ensuring(removeBlock(input)),
    )
  })

  const markBackground = Effect.fnUntraced(function* (job: Active) {
    const next = {
      ...job,
      isBackgrounded: true,
      blockingSessions: new Map<SessionSchema.ID, number>(),
      info: {
        ...job.info,
        ...(job.recovery ? { notificationID: job.info.notificationID ?? SessionMessage.ID.create() } : {}),
      },
    }
    return { job: next, background: yield* persistBackground(next) }
  })

  const background: Interface["background"] = Effect.fn("Job.background")(function* (id) {
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [BackgroundResult, Map<string, Active>]> {
        const job = jobs.get(id)
        // Recoverable work may finish before the caller backgrounds it.
        if (!job || (job.info.status !== "running" && !job.recovery)) return [{}, jobs]
        if (job.isBackgrounded) return [{ info: snapshot(job) }, jobs]
        const next = yield* markBackground(job)
        return [
          { info: snapshot(next.job), backgrounded: job.backgrounded, background: next.background },
          new Map(jobs).set(id, next.job),
        ]
      }),
    )
    if (result.info && result.backgrounded) yield* Deferred.succeed(result.backgrounded, result.info)
    if (result.background?.recovery.kind === "subagent" && result.background.status !== "running")
      yield* notifyBackgroundSettled(result.background)
    return result.info
  })

  const backgroundAll: Interface["backgroundAll"] = Effect.fn("Job.backgroundAll")(function* (input) {
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<
        readonly [{ info: Info; backgrounded: Deferred.Deferred<Info> }[], Map<string, Active>]
      > {
        const results: { info: Info; backgrounded: Deferred.Deferred<Info> }[] = []
        const next = new Map(jobs)
        for (const [id, job] of jobs) {
          if (job.info.status !== "running") continue
          if (job.isBackgrounded) continue
          if (input.type !== undefined && job.info.type !== input.type) continue
          if (!job.blockingSessions.has(input.sessionID)) continue
          const updated = yield* markBackground(job)
          results.push({ info: snapshot(updated.job), backgrounded: job.backgrounded })
          next.set(id, updated.job)
        }
        return [results, next]
      }),
    )
    yield* Effect.forEach(result, (item) => Deferred.succeed(item.backgrounded, item.info), { discard: true })
    return result.map((item) => item.info)
  })

  const running: Interface["running"] = Effect.fn("Job.running")(function* (sessionID) {
    const jobs = yield* SynchronizedRef.get(state.jobs)
    const found: Info[] = []
    for (const job of jobs.values())
      if (job.info.status === "running" && job.info.metadata?.["sessionID"] === sessionID) found.push(snapshot(job))
    return found
  })

  const activeSessions: Interface["activeSessions"] = Effect.gen(function* () {
    const jobs = yield* SynchronizedRef.get(state.jobs)
    const sessions = new Set<SessionSchema.ID>()
    for (const job of jobs.values()) {
      const sessionID = job.info.metadata?.["sessionID"]
      if (job.info.status === "running" && typeof sessionID === "string") sessions.add(SessionSchema.ID.make(sessionID))
    }
    for (const { background } of deliveries.values()) {
      sessions.add(
        background.recovery.kind === "shell" ? background.recovery.sessionID : background.recovery.parentSessionID,
      )
    }
    return sessions
  }).pipe(Effect.withSpan("Job.activeSessions"))

  const cancel: Interface["cancel"] = Effect.fn("Job.cancel")(function* (id) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [FinishResult, Map<string, Active>]> {
        const job = jobs.get(id)
        if (!job) return [{}, jobs]
        if (job.info.status !== "running") return [{ info: snapshot(job), generation: job.scope }, jobs]
        const next = {
          ...job,
          blockingSessions: new Map<SessionSchema.ID, number>(),
          info: {
            ...job.info,
            status: "cancelled" as const,
            completed_at,
          },
        }
        const background = yield* persistBackground(next)
        return [
          {
            info: snapshot(next),
            done: job.done,
            scope: job.scope,
            generation: job.scope,
            ...(next.isBackgrounded && background ? { background } : {}),
          },
          new Map(jobs).set(id, next),
        ]
      }),
    )
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info)
    if (result.scope) yield* Scope.close(result.scope, Exit.void)
    if (result.generation) yield* consume(id, result.generation)
    return result.info
  })

  const pendingBackground: Interface["pendingBackground"] = Effect.gen(function* () {
    const recovered: Background[] = []
    let after: string | undefined
    do {
      const page = yield* kv.scan({ prefix: backgroundPrefix, after })
      recovered.push(...Array.filterMap(page.entries, (entry) => decodeBackground(entry.value)))
      after = page.next
    } while (after)
    return recovered
  }).pipe(Effect.withSpan("Job.pendingBackground"))

  const awaitOwned: Interface["awaitOwned"] = Effect.fn("Job.awaitOwned")(function* (sessionID) {
    const jobs = yield* SynchronizedRef.get(state.jobs)
    const waits = [
      ...Array.fromIterable(jobs.values())
        .filter((job) => job.info.status === "running" && job.info.metadata?.["sessionID"] === sessionID)
        .map((job) => Deferred.await(job.done).pipe(Effect.asVoid)),
      ...Array.fromIterable(deliveries.values())
        .filter(
          ({ background }) =>
            (background.recovery.kind === "shell"
              ? background.recovery.sessionID
              : background.recovery.parentSessionID) === sessionID,
        )
        .map((entry) => Deferred.await(entry.done)),
    ]
    yield* Effect.all(waits, { discard: true })
    return waits.length > 0
  })

  const completeBackground: Interface["completeBackground"] = Effect.fn("Job.completeBackground")((notificationID) =>
    SynchronizedRef.updateEffect(state.jobs, (jobs) =>
      Effect.gen(function* () {
        yield* kv.remove(`${backgroundPrefix}${notificationID}`)
        const delivery = deliveries.get(notificationID)
        deliveries.delete(notificationID)
        if (delivery) yield* Deferred.succeed(delivery.done, undefined)
        const entry = [...jobs].find(([, job]) => job.info.notificationID === notificationID)
        if (!entry || entry[1].info.status === "running") return jobs
        const next = new Map(jobs)
        next.delete(entry[0])
        return next
      }),
    ),
  )

  const removeSession: Interface["removeSession"] = Effect.fn("Job.removeSession")(function* (sessionID) {
    const completed_at = yield* Clock.currentTimeMillis
    const scopes = yield* SynchronizedRef.modifyEffect(state.jobs, (jobs) =>
      Effect.gen(function* () {
        const next = new Map(jobs)
        const scopes: Scope.Closeable[] = []
        for (const [id, job] of jobs) {
          if (
            job.info.metadata?.["sessionID"] !== sessionID &&
            !(job.recovery && referencesSession(job.recovery, sessionID))
          )
            continue
          next.delete(id)
          if (job.info.status !== "running") continue
          scopes.push(job.scope)
          yield* Deferred.succeed(job.done, { ...snapshot(job), status: "cancelled", completed_at })
        }
        for (const [notificationID, delivery] of deliveries) {
          if (!referencesSession(delivery.background.recovery, sessionID)) continue
          yield* kv.remove(`${backgroundPrefix}${notificationID}`)
          deliveries.delete(notificationID)
          yield* Deferred.succeed(delivery.done, undefined)
        }
        return [scopes, next] as const
      }),
    )
    // Remove ownership before interruption can settle the old job and recreate its marker.
    yield* Effect.forEach(scopes, (scope) => Scope.close(scope, Exit.void), { concurrency: "unbounded", discard: true })
  }, Effect.uninterruptible)

  const onBackgroundSettled: Interface["onBackgroundSettled"] = (listener) =>
    Effect.sync(() => {
      state.backgroundListeners.add(listener)
      return Effect.sync(() => state.backgroundListeners.delete(listener))
    })

  return Service.of({
    get,
    start,
    wait,
    observe,
    block,
    background,
    backgroundAll,
    running,
    awaitOwned,
    activeSessions,
    cancel,
    removeSession,
    pendingBackground,
    onBackgroundSettled,
    completeBackground,
  })
})

function referencesSession(recovery: Recovery, sessionID: SessionSchema.ID) {
  return recovery.kind === "shell"
    ? recovery.sessionID === sessionID
    : recovery.parentSessionID === sessionID || recovery.childSessionID === sessionID
}

const layer = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer, deps: [KV.node] })
