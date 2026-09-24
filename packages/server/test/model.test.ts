import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect, Schedule } from "effect"
import { OpenCode } from "@opencode/client"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

it.live("lists models without blocking on plugin initialization", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-model-endpoint-")))
    yield* Effect.promise(() =>
      fs.writeFile(
        path.join(tmp.path, "opencode.json"),
        JSON.stringify({
          providers: {
            custom: {
              package: "aisdk:@ai-sdk/openai-compatible",
              settings: { apiKey: "secret" },
              models: { chat: {} },
            },
          },
        }),
      ),
    )
    const server = yield* startServer(tmp.path)
    const url = new URL("/api/model", server.base)
    url.searchParams.set("location[directory]", tmp.path)
    const request = Effect.fnUntraced(function* () {
      const response = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
      expect(response.status).toBe(200)
      const body: unknown = yield* Effect.promise(() => response.json())
      if (!isRecord(body) || !Array.isArray(body["data"])) throw new Error("Expected a model list response")
      return body["data"].some((model) => isRecord(model) && model["providerID"] === "custom" && model["id"] === "chat")
    })
    yield* request().pipe(
      Effect.filterOrFail((found) => found),
      Effect.retry(Schedule.spaced("10 millis")),
      Effect.timeout("2 seconds"),
    )
  }),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

for (const scenario of [
  { name: "configured buffer", auto: true, context: 200_000, threshold: 107_000 },
  { name: "model compaction target", auto: true, context: 200_000, target: 90_000, threshold: 90_000 },
  { name: "target above safe ceiling", auto: true, context: 200_000, target: 150_000, threshold: 107_000 },
  { name: "disabled auto compaction", auto: false, context: 200_000, threshold: undefined },
  { name: "unknown context size", auto: true, context: 0, threshold: undefined },
]) {
  it.live(`model endpoints expose the compaction threshold with ${scenario.name}`, () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-model-compaction-")))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tmp.path, "opencode.json"),
          JSON.stringify({
            model: "custom/chat",
            compaction: { auto: scenario.auto, buffer: 13_000 },
            providers: {
              custom: {
                package: "aisdk:@ai-sdk/openai-compatible",
                settings: { apiKey: "secret" },
                models: {
                  chat: {
                    limit: {
                      context: scenario.context,
                      input: 120_000,
                      output: 32_000,
                      ...("target" in scenario ? { compaction: scenario.target } : {}),
                    },
                  },
                },
              },
            },
          }),
        ),
      )
      const server = yield* startServer(tmp.path)
      const client = OpenCode.make({ baseUrl: server.base, headers: server.headers })
      const query = { location: { directory: tmp.path } }
      const model = yield* Effect.promise(() => client.model.list(query)).pipe(
        Effect.map((result) => result.data.find((model) => model.providerID === "custom" && model.id === "chat")),
        Effect.filterOrFail((model) => model !== undefined && model.limit.compaction === scenario.threshold),
        Effect.retry(Schedule.spaced("10 millis")),
        Effect.timeout("5 seconds"),
      )
      expect(model?.limit).toEqual({
        context: scenario.context,
        input: 120_000,
        output: 32_000,
        ...(scenario.threshold === undefined ? {} : { compaction: scenario.threshold }),
      })
      const fallback = yield* Effect.promise(() => client.model.default(query))
      expect(fallback.data?.limit).toEqual(model?.limit)
    }),
  )
}
