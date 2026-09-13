import { Catalog } from "@opencode-ai/core/catalog"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import type { Model } from "@opencode-ai/schema/model"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const ModelHandler = HttpApiBuilder.group(Api, "server.model", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "model.list",
        Effect.fn(function* () {
          const catalog = yield* Catalog.Service
          const compaction = yield* SessionCompaction.Service
          return yield* response(
            catalog.model
              .available()
              .pipe(Effect.map((models) => models.map((model) => withCompactionLimit(model, compaction)))),
          )
        }),
      )
      .handle(
        "model.default",
        Effect.fn(function* () {
          const catalog = yield* Catalog.Service
          const compaction = yield* SessionCompaction.Service
          return yield* response(
            catalog.model.default().pipe(Effect.map((model) => model && withCompactionLimit(model, compaction))),
          )
        }),
      )
  }),
)

function withCompactionLimit(model: Model.Info, compaction: SessionCompaction.Interface) {
  return { ...model, limit: { ...model.limit, compaction: compaction.threshold(model.limit) } }
}
