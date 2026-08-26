import { and, asc, desc, eq, gte, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database.js"
import { EventSequenceTable } from "../event/sql.js"
import { MessageDecodeError } from "./error.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { Instructions } from "../instructions/index.js"
import { InstructionState } from "./instruction-state.js"
import { SessionMessageTable } from "./sql.js"

type DatabaseService = Database.Interface["db"]

const decode = Schema.decodeUnknownEffect(SessionMessage.Info)
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

const preparedQueries = new WeakMap<DatabaseService, ReturnType<typeof prepareQueries>>()
const cacheStates = new WeakMap<Cache, CacheState>()

type MessageEntry = { readonly seq: number; readonly message: SessionMessage.Info }
type DecodableMessageRow = Pick<typeof SessionMessageTable.$inferSelect, "id" | "session_id" | "type"> & {
  readonly data: unknown
}
type HistoryRow = DecodableMessageRow &
  Pick<typeof SessionMessageTable.$inferSelect, "seq" | "time_updated"> & {
    readonly data: string
  }
type CachedRow = Pick<HistoryRow, "id" | "type" | "seq" | "time_updated" | "data"> & {
  readonly message: SessionMessage.Info
}
type CachedEntries = {
  readonly revision: number
  readonly entries: ReadonlyArray<MessageEntry>
  readonly rows: ReadonlyMap<SessionMessage.ID, CachedRow>
}
type CacheState = { readonly entries: Map<SessionSchema.ID, CachedEntries> }

export interface Cache {
  readonly close: () => void
}

export const makeCache = (): Cache => {
  const cache: Cache = {
    close: () => {
      const state = cacheStates.get(cache)
      if (!state) return
      state.entries.clear()
      cacheStates.delete(cache)
    },
  }
  cacheStates.set(cache, { entries: new Map() })
  return cache
}

function prepareQueries(db: DatabaseService) {
  return {
    revision: db
      .select({ seq: EventSequenceTable.seq })
      .from(EventSequenceTable)
      .where(eq(EventSequenceTable.aggregate_id, sql.placeholder("sessionID")))
      .prepare(),
    compaction: db
      .select({ seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.session_id, sql.placeholder("sessionID")),
          eq(SessionMessageTable.type, "compaction"),
          sql`json_extract(${SessionMessageTable.data}, '$.status') = 'completed'`,
        ),
      )
      .orderBy(desc(SessionMessageTable.seq))
      .limit(1)
      .prepare(),
    entries: db
      .select({
        id: SessionMessageTable.id,
        session_id: SessionMessageTable.session_id,
        type: SessionMessageTable.type,
        seq: SessionMessageTable.seq,
        time_updated: SessionMessageTable.time_updated,
        // Keep persisted JSON opaque until the row is known to have changed.
        data: sql<string>`${SessionMessageTable.data}`.as("data"),
      })
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.session_id, sql.placeholder("sessionID")),
          gte(SessionMessageTable.seq, sql.placeholder("fromSeq")),
        ),
      )
      .orderBy(asc(SessionMessageTable.seq))
      .prepare(),
  }
}

function queriesFor(db: DatabaseService) {
  const existing = preparedQueries.get(db)
  if (existing) return existing
  const queries = prepareQueries(db)
  preparedQueries.set(db, queries)
  return queries
}

export const latestCompaction = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* queriesFor(db).compaction.get({ sessionID }).pipe(Effect.orDie)
})

export const decodeMessageRow = (row: DecodableMessageRow) =>
  decode({
    ...(typeof row.data === "object" && row.data !== null ? row.data : {}),
    id: row.id,
    type: row.type,
  }).pipe(
    Effect.mapError(
      () =>
        new MessageDecodeError({
          sessionID: SessionSchema.ID.make(row.session_id),
          messageID: SessionMessage.ID.make(row.id),
        }),
    ),
  )

const messageEntries = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  cache: Cache | undefined,
) {
  const queries = queriesFor(db)
  const state = cache ? cacheStates.get(cache) : undefined
  // The bus advances this row in the same transaction as every durable projection.
  const revision = yield* queries.revision.get({ sessionID }).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!revision) {
    state?.entries.delete(sessionID)
    return (yield* loadEntries(queries, sessionID, undefined)).entries
  }
  const cached = state?.entries.get(sessionID)
  if (cached && cached.revision === revision.seq) return cached.entries

  const loaded = yield* loadEntries(queries, sessionID, cached)
  if (state && cache && cacheStates.get(cache) === state)
    state.entries.set(sessionID, { revision: revision.seq, ...loaded })
  return loaded.entries
})

function loadEntries(
  queries: ReturnType<typeof prepareQueries>,
  sessionID: SessionSchema.ID,
  cached: CachedEntries | undefined,
) {
  return Effect.gen(function* () {
    const compaction = yield* queries.compaction.get({ sessionID }).pipe(Effect.orDie)
    const rows = yield* queries.entries.all({ sessionID, fromSeq: compaction?.seq ?? -1 }).pipe(Effect.orDie)
    const loaded = yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const previous = cached?.rows.get(row.id)
        if (
          previous &&
          previous.type === row.type &&
          previous.seq === row.seq &&
          previous.time_updated === row.time_updated &&
          previous.data === row.data
        )
          return { row, entry: { seq: row.seq, message: previous.message } }

        const data =
          typeof row.data === "string"
            ? yield* decodeJson(row.data).pipe(
                Effect.catch(() =>
                  Effect.fail(
                    new MessageDecodeError({
                      sessionID: SessionSchema.ID.make(row.session_id),
                      messageID: SessionMessage.ID.make(row.id),
                    }),
                  ),
                ),
              )
            : row.data
        const message = yield* decodeMessageRow({ ...row, data })
        return { row, entry: { seq: row.seq, message } }
      }),
    )
    return {
      entries: loaded.map((item) => item.entry),
      rows: new Map(
        loaded.map(({ row, entry }) => [
          row.id,
          {
            id: row.id,
            type: row.type,
            seq: row.seq,
            time_updated: row.time_updated,
            data: row.data,
            message: entry.message,
          },
        ]),
      ),
    }
  })
}

export const load = Effect.fn("SessionHistory.load")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  cache?: Cache,
) {
  return (yield* messageEntries(db, sessionID, cache)).map((entry) => entry.message)
})

export const entriesForRunner = Effect.fn("SessionHistory.entriesForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  instructions: Instructions.List,
  cache?: Cache,
) {
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const messages = yield* messageEntries(db, sessionID, cache)
        return {
          initial: yield* InstructionState.initial(db, sessionID, instructions),
          entries: messages,
        }
      }),
    )
    .pipe(Effect.orDie)
})

export const preview = Effect.fn("SessionHistory.preview")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  instructions: Instructions.List,
) {
  const observed = yield* Instructions.read(instructions)
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const messages = yield* messageEntries(db, sessionID, undefined)
        // An active assistant may contain an unresolved tool call, so only preview the settled prefix.
        const unsettled = messages.findIndex(
          (entry) => entry.message.type === "assistant" && entry.message.time.completed === undefined,
        )
        const settled = unsettled === -1 ? messages : messages.slice(0, unsettled)
        const assembled = yield* InstructionState.preview(db, sessionID, instructions, observed)
        return {
          initial: assembled.initial,
          messages: settled.map((entry) => entry.message),
          instructionUpdate: assembled.update,
        }
      }),
    )
    .pipe(Effect.catch((error) => (error instanceof Instructions.InitializationBlocked ? error : Effect.die(error))))
})

/** Returns the session's first user message. */
export const firstUserMessage = Effect.fn("SessionHistory.firstUserMessage")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user")))
    .orderBy(asc(SessionMessageTable.seq))
    .get()
    .pipe(Effect.orDie)
  if (!row) return undefined
  const message = yield* decodeMessageRow(row).pipe(Effect.orElseSucceed(() => undefined))
  return message?.type === "user" ? message : undefined
})

export * as SessionHistory from "./history.js"
