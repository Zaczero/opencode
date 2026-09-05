export * as ConfigCompactionPlugin from "./compaction.js"

import { define } from "@opencode-ai/plugin/effect/plugin"
import { Effect } from "effect"
import { Config } from "../../config.js"
import { SessionCompaction } from "../../session/compaction.js"
import { Model } from "../../model.js"
import { ConfigEntryObserver } from "./entry-observer.js"

export const Plugin = define({
  id: "opencode.config.compaction",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const compaction = yield* SessionCompaction.Service
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, compaction.reload())
    yield* compaction.transform((draft) => {
      for (const entry of loaded.entries) {
        if (entry.type !== "document" || !entry.info.compaction) continue
        draft.configure({
          ...(entry.info.compaction.auto === undefined ? {} : { auto: entry.info.compaction.auto }),
          ...(entry.info.compaction.model === undefined
            ? {}
            : {
                model: Model.Ref.make({
                  providerID: entry.info.compaction.model.providerID,
                  id: entry.info.compaction.model.model,
                  variant: entry.info.compaction.model.variant,
                }),
              }),
          ...(entry.info.compaction.buffer === undefined ? {} : { buffer: entry.info.compaction.buffer }),
          ...(entry.info.compaction.keep?.tokens === undefined ? {} : { tokens: entry.info.compaction.keep.tokens }),
        })
      }
    })
  }),
})
