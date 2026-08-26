import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { and, eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventSequenceTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/schema/session"
import { SessionHistory } from "@opencode-ai/core/session/history"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(Database.node))
const projectID = Project.ID.make("history-project")
const sessionID = Session.ID.make("ses_history")
const created = DateTime.makeUnsafe(0)
const encodeMessage = Schema.encodeSync(SessionMessage.Info)

const user = (id: string, text: string) =>
  SessionMessage.User.make({
    id: SessionMessage.ID.make(id),
    type: "user",
    text,
    time: { created },
  })

const messageRow = (message: SessionMessage.Info, seq: number) => {
  const { id, type, ...data } = encodeMessage(message)
  return {
    id: SessionMessage.ID.make(id),
    session_id: sessionID,
    type,
    seq,
    time_created: 0,
    time_updated: seq,
    data,
  }
}

describe("SessionHistory", () => {
  it.effect("reuses unchanged message objects while following durable revisions", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/history"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({ id: sessionID, project_id: projectID, slug: "history", directory: "/history", version: "test" })
        .run()
      yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 0 }).run()

      const first = user("msg_first", "first")
      const second = user("msg_second", "second")
      yield* db
        .insert(SessionMessageTable)
        .values([messageRow(first, 1), messageRow(second, 2)])
        .run()

      const cache = SessionHistory.makeCache()
      const initial = yield* SessionHistory.load(db, sessionID, cache)
      const unchanged = yield* SessionHistory.load(db, sessionID, cache)
      expect(unchanged[0]).toBe(initial[0])
      expect(unchanged[1]).toBe(initial[1])

      const updated = user("msg_second", "updated")
      const encoded = encodeMessage(updated)
      const { id: _, type: __, ...data } = encoded
      yield* db
        .update(SessionMessageTable)
        .set({ data, time_updated: 3 })
        .where(and(eq(SessionMessageTable.id, updated.id), eq(SessionMessageTable.session_id, sessionID)))
        .run()
      yield* db.update(EventSequenceTable).set({ seq: 1 }).where(eq(EventSequenceTable.aggregate_id, sessionID)).run()

      const changed = yield* SessionHistory.load(db, sessionID, cache)
      expect(changed[0]).toBe(initial[0])
      expect(changed[1]).not.toBe(initial[1])
      expect(changed[1]).toMatchObject({ text: "updated" })

      const compaction = SessionMessage.Compaction.make({
        id: SessionMessage.ID.make("msg_compaction"),
        type: "compaction",
        status: "completed",
        reason: "auto",
        summary: "Earlier work",
        recent: "Recent work",
        time: { created },
      })
      yield* db.insert(SessionMessageTable).values(messageRow(compaction, 3)).run()
      yield* db.update(EventSequenceTable).set({ seq: 2 }).where(eq(EventSequenceTable.aggregate_id, sessionID)).run()
      const compacted = yield* SessionHistory.load(db, sessionID, cache)
      expect(compacted.map((message) => message.id)).toEqual([compaction.id])

      const resumed = user("msg_resumed", "resumed")
      yield* db.insert(SessionMessageTable).values(messageRow(resumed, 4)).run()
      yield* db.update(EventSequenceTable).set({ seq: 3 }).where(eq(EventSequenceTable.aggregate_id, sessionID)).run()
      const resumedHistory = yield* SessionHistory.load(db, sessionID, cache)
      expect(resumedHistory[0]).toBe(compacted[0])
      expect(resumedHistory[1]).toMatchObject({ text: "resumed" })

      yield* db
        .delete(SessionMessageTable)
        .where(and(eq(SessionMessageTable.id, resumed.id), eq(SessionMessageTable.session_id, sessionID)))
        .run()
      yield* db.update(EventSequenceTable).set({ seq: 4 }).where(eq(EventSequenceTable.aggregate_id, sessionID)).run()
      expect((yield* SessionHistory.load(db, sessionID, cache)).map((message) => message.id)).toEqual([compaction.id])

      cache.close()
      const afterClose = yield* SessionHistory.load(db, sessionID, cache)
      expect(afterClose[0]).not.toBe(compacted[0])
      const cold = SessionHistory.makeCache()
      const coldHistory = yield* SessionHistory.load(db, sessionID, cold)
      expect(coldHistory.map((message) => message.id)).toEqual([compaction.id])
      expect(coldHistory[0]).not.toBe(compacted[0])
      cold.close()
    }),
  )

  it.effect("does not cache storage without a durable revision", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/history"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({ id: sessionID, project_id: projectID, slug: "history", directory: "/history", version: "test" })
        .run()
      const message = user("msg_uncertain", "before")
      yield* db.insert(SessionMessageTable).values(messageRow(message, 1)).run()

      const cache = SessionHistory.makeCache()
      const initial = yield* SessionHistory.load(db, sessionID, cache)
      const updated = user("msg_uncertain", "after")
      const encoded = encodeMessage(updated)
      const { id: _, type: __, ...data } = encoded
      yield* db.update(SessionMessageTable).set({ data }).where(eq(SessionMessageTable.id, message.id)).run()

      const updatedHistory = yield* SessionHistory.load(db, sessionID, cache)
      expect(updatedHistory[0]).toMatchObject({ text: "after" })
      expect(updatedHistory[0]).not.toBe(initial[0])
      cache.close()
    }),
  )

  it.effect("keeps active cache scopes independent and releases one at close", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const otherSessionID = Session.ID.make("ses_history_other")
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/history"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values([
          { id: sessionID, project_id: projectID, slug: "history", directory: "/history", version: "test" },
          { id: otherSessionID, project_id: projectID, slug: "other", directory: "/history", version: "test" },
        ])
        .run()
      yield* db
        .insert(EventSequenceTable)
        .values([
          { aggregate_id: sessionID, seq: 0 },
          { aggregate_id: otherSessionID, seq: 0 },
        ])
        .run()
      const first = user("msg_scope_first", "first")
      const second = user("msg_scope_second", "second")
      yield* db
        .insert(SessionMessageTable)
        .values([messageRow(first, 1), { ...messageRow(second, 1), session_id: otherSessionID }])
        .run()

      const firstCache = SessionHistory.makeCache()
      const secondCache = SessionHistory.makeCache()
      const firstHistory = yield* SessionHistory.load(db, sessionID, firstCache)
      const secondHistory = yield* SessionHistory.load(db, otherSessionID, secondCache)
      yield* SessionHistory.load(db, sessionID, firstCache)
      yield* SessionHistory.load(db, otherSessionID, secondCache)

      firstCache.close()
      expect((yield* SessionHistory.load(db, sessionID, firstCache))[0]).not.toBe(firstHistory[0])
      expect((yield* SessionHistory.load(db, otherSessionID, secondCache))[0]).toBe(secondHistory[0])

      secondCache.close()
    }),
  )
})
