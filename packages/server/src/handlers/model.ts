import { Model } from "@opencode/core/model"
import { SessionCompaction } from "@opencode/core/session/compaction"
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
          const models = yield* Model.Service
          const compaction = yield* SessionCompaction.Service
          return yield* response(
            models
              .available()
              .pipe(Effect.map((models) => models.map((model) => withCompactionLimit(model, compaction)))),
          )
        }),
      )
      .handle(
        "model.default",
        Effect.fn(function* () {
          const models = yield* Model.Service
          const compaction = yield* SessionCompaction.Service
          return yield* response(
            models.default().pipe(Effect.map((model) => model && withCompactionLimit(model, compaction))),
          )
        }),
      )
  }),
)

function withCompactionLimit(model: Model.Info, compaction: SessionCompaction.Interface) {
  return { ...model, limit: { ...model.limit, compaction: compaction.threshold(model.limit) } }
}
