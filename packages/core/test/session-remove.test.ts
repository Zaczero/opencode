import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, RcMap, Scope } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Job } from "@opencode/core/job"
import { Instance } from "@opencode/core/instance/service"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { SessionEnvironment } from "@opencode/core/session/environment"
import { LocationServiceMap } from "@opencode/core/location-services"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"

const closed: Session.ID[] = []
const transportScopes = new Set<Scope.Scope>()
const transport = Layer.effect(
  SessionModelTransport.Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    transportScopes.add(scope)
    yield* Effect.addFinalizer(() => Effect.sync(() => transportScopes.delete(scope)))
    return SessionModelTransport.Service.of({
      bind: () => ({ execute: () => Effect.die("Unexpected WebSocket execution") }),
      close: (sessionID) => Effect.sync(() => closed.push(sessionID)),
      closeAll: Effect.void,
    })
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      SessionEnvironment.node,
      Session.node,
      Job.node,
      SessionRestart.node,
      Instance.node,
      LocationServiceMap.node,
    ]),
    [
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      SessionModelTransport.node.replace(transport),
      offlineModels,
    ],
  ),
)

describe("Session.remove", () => {
  it.live("retires child-owned work and parent notifications without stopping another session", () =>
    Effect.gen(function* () {
      const temporary = yield* tmpdirScoped()
      const sessions = yield* Session.Service
      const jobs = yield* Job.Service
      const location = Location.Ref.make({ directory: AbsolutePath.make(temporary.path) })
      const parent = yield* sessions.create({ location })
      const child = yield* sessions.create({ parentID: parent.id })
      const other = yield* sessions.create({ location })
      const stopped = yield* Deferred.make<void>()
      const otherStopped = yield* Deferred.make<void>()
      const shell = yield* jobs.start({
        type: "shell",
        metadata: { sessionID: child.id },
        recovery: { kind: "shell", sessionID: child.id, shellID: "sh_deleted", command: "build" },
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(stopped, undefined))),
      })
      const completed = yield* jobs.start({
        type: "shell",
        metadata: { sessionID: child.id },
        recovery: { kind: "shell", sessionID: child.id, shellID: "sh_completed", command: "check" },
        run: Effect.succeed("checked"),
      })
      const subagent = yield* jobs.start({
        id: child.id,
        type: "subagent",
        metadata: { sessionID: parent.id, childID: child.id },
        recovery: {
          kind: "subagent",
          parentSessionID: parent.id,
          childSessionID: child.id,
          agent: "code",
          description: "Build",
        },
        run: Effect.succeed("child idle"),
      })
      const unrelated = yield* jobs.start({
        type: "shell",
        metadata: { sessionID: other.id },
        recovery: { kind: "shell", sessionID: other.id, shellID: "sh_other", command: "other build" },
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(otherStopped, undefined))),
      })
      for (const job of [shell, completed, subagent, unrelated]) yield* jobs.background(job.id)
      yield* jobs.wait({ id: completed.id })
      yield* jobs.wait({ id: subagent.id })
      const waiters = yield* Effect.forEach([child.id, parent.id], (id) =>
        jobs.awaitOwned(id).pipe(Effect.forkScoped({ startImmediately: true })),
      )

      yield* sessions.remove(child.id)

      expect(yield* Deferred.isDone(stopped)).toBe(true)
      expect(yield* Deferred.isDone(otherStopped)).toBe(false)
      expect(yield* Effect.forEach(waiters, Fiber.join)).toEqual([true, true])
      expect(yield* jobs.activeSessions).toEqual(new Set([other.id]))
      expect(yield* jobs.pendingBackground).toMatchObject([{ id: unrelated.id, status: "running" }])
      for (const job of [shell, completed, subagent]) expect(yield* jobs.get(job.id)).toBeUndefined()
      expect((yield* sessions.get(parent.id)).id).toBe(parent.id)
      expect(yield* Effect.result(sessions.get(child.id))).toMatchObject({ _tag: "Failure" })
      yield* sessions.remove(other.id)
      expect(yield* Deferred.isDone(otherStopped)).toBe(true)
      expect(yield* jobs.pendingBackground).toEqual([])
    }),
  )

  it.effect("removes a session and its children", () =>
    Effect.gen(function* () {
      const temporary = yield* tmpdirScoped()
      const location = Location.Ref.make({ directory: AbsolutePath.make(temporary.path) })
      const session = yield* Session.Service
      const parent = yield* session.create({ location })
      const child = yield* session.create({ parentID: parent.id })
      yield* session.environment({ sessionID: parent.id, variables: { SESSION_ENV: "parent" } })
      yield* session.environment({ sessionID: child.id, variables: { SESSION_ENV: "child" } })
      const locations = yield* LocationServiceMap.Service
      yield* Effect.acquireRelease(locations.contextEffect(location), () => locations.invalidate(location))
      closed.length = 0

      yield* session.remove(parent.id)

      expect((yield* session.list()).data).toEqual([])
      expect(closed).toEqual([parent.id, child.id])
      const environments = yield* SessionEnvironment.Service
      expect(yield* environments.get(parent.id)).toBeUndefined()
      expect(yield* environments.get(child.id)).toBeUndefined()
      expect(yield* Effect.result(session.get(parent.id))).toMatchObject({ _tag: "Failure" })
      expect(yield* Effect.result(session.get(child.id))).toMatchObject({ _tag: "Failure" })
    }),
  )

  it.live("removes unloaded sessions and children without initializing an instance", () =>
    Effect.gen(function* () {
      const temporary = yield* tmpdirScoped()
      const sessions = yield* Session.Service
      const locations = yield* LocationServiceMap.Service
      const parent = yield* sessions.create({
        location: Location.Ref.make({ directory: AbsolutePath.make(temporary.path) }),
      })
      const child = yield* sessions.create({ parentID: parent.id })
      closed.length = 0
      expect(Array.from(yield* RcMap.keys(locations.rcMap))).toEqual([])

      yield* sessions.remove(parent.id)

      expect(closed).toEqual([parent.id, child.id])
      expect(transportScopes.size).toBe(1)
      expect(Array.from(yield* RcMap.keys(locations.rcMap))).toEqual([])
      expect((yield* sessions.list()).data).toEqual([])
    }),
  )

  it.effect("fails when the session does not exist", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const sessionID = Session.ID.make("ses_missing")

      expect(yield* Effect.result(session.remove(sessionID))).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "Session.NotFoundError", sessionID },
      })
    }),
  )
})
