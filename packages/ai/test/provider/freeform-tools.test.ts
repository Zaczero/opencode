import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMEvent, Message, ToolCallPart } from "../../src/index.js"
import { Auth, LLMClient } from "../../src/route.js"
import { compileRequest } from "../../src/route/client.js"
import * as OpenAIResponses from "../../src/protocols/openai-responses.js"
import { it } from "../lib/effect.js"
import { fixedResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const model = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4.1-mini" })
const tool = {
  name: "apply_patch",
  description: "Edit files.",
  inputSchema: { type: "object", properties: { patchText: { type: "string" } }, required: ["patchText"] },
  format: { type: "grammar" as const, syntax: "lark" as const, definition: 'start: "patch"' },
}
const messages = (input: unknown, namespace?: string) => [
  Message.user("Fix it."),
  Message.assistant([ToolCallPart.make({ id: "call_1", name: tool.name, namespace, input })]),
  Message.tool({ id: "call_1", name: tool.name, namespace, result: "Invalid patch", resultType: "text" }),
]

describe("freeform tool encoding", () => {
  it.effect("forces the advertised custom tool type", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({ model, prompt: "Fix it.", tools: [tool], toolChoice: tool.name }),
      )
      expect(prepared.body.tool_choice).toEqual({ type: "custom", name: tool.name })
    }),
  )

  it.effect("keeps namespaced grammar tools as functions throughout replay and selection", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          messages: messages({ patchText: "patch" }, "files"),
          tools: [{ type: "namespace", name: "files", tools: [tool] }],
          providerOptions: { allowedTools: { toolNames: [tool.name], mode: "required" } },
        }),
      )
      expect(prepared.body.tools).toMatchObject([{ type: "namespace", tools: [{ type: "function", name: tool.name }] }])
      expect(prepared.body.tool_choice).toEqual({
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "function", name: tool.name }],
      })
      expect(prepared.body.input).toMatchObject([
        { role: "user" },
        { type: "function_call", call_id: "call_1", arguments: '{"patchText":"patch"}' },
        { type: "function_call_output", call_id: "call_1" },
      ])
    }),
  )

  it.effect("does not advertise a non-string property as raw text", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          prompt: "Fix it.",
          tools: [{ ...tool, inputSchema: { type: "object", properties: { count: { type: "number" } } } }],
        }),
      )
      expect(prepared.body.tools).toMatchObject([
        { type: "function", parameters: { properties: { count: { type: "number" } } } },
      ])
    }),
  )

  it.effect("matches each replayed result to its call's actual encoding", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({ model, tools: [tool], messages: messages({ wrongProperty: "patch" }) }),
      )
      expect(prepared.body.input).toMatchObject([
        { role: "user" },
        { type: "function_call", call_id: "call_1", arguments: '{"wrongProperty":"patch"}' },
        { type: "function_call_output", call_id: "call_1" },
      ])
    }),
  )

  it.effect("keeps a namespaced call distinct from a same-named custom tool", () =>
    Effect.gen(function* () {
      const prepared = yield* compileRequest(
        LLM.request({
          model,
          tools: [tool, { type: "namespace", name: "files", tools: [tool] }],
          messages: messages({ patchText: "patch" }, "files"),
        }),
      )
      expect(prepared.body.input).toMatchObject([
        { role: "user" },
        { type: "function_call", namespace: "files", call_id: "call_1" },
        { type: "function_call_output", call_id: "call_1" },
      ])
    }),
  )

  for (const ending of ["deltas", "input-done", "item-done", "response-output"] as const) {
    it.effect(`preserves raw text when the stream ends with ${ending}`, () =>
      Effect.gen(function* () {
        const item = { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: tool.name, input: "" }
        const raw = "*** Begin Patch\n*** End Patch"
        const final = ending === "deltas" ? raw : `${raw}\n`
        const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Fix it.", tools: [tool] })).pipe(
          Effect.provide(
            fixedResponse(
              sseEvents(
                { type: "response.output_item.added", output_index: 0, item },
                { type: "response.custom_tool_call_input.delta", item_id: item.id, delta: raw },
                ...(ending === "input-done"
                  ? [{ type: "response.custom_tool_call_input.done", item_id: item.id, input: final }]
                  : []),
                ...(ending === "item-done"
                  ? [{ type: "response.output_item.done", output_index: 0, item: { ...item, input: final } }]
                  : []),
                {
                  type: "response.completed",
                  response: {
                    id: "resp_1",
                    ...(ending === "response-output" ? { output: [{ ...item, input: final }] } : {}),
                  },
                },
              ),
            ),
          ),
        )
        expect(response.events.filter(LLMEvent.is.toolCall)).toEqual([
          expect.objectContaining({ id: "call_1", name: tool.name, input: { patchText: final } }),
        ])
        expect(response.events.filter((event) => event.type === "tool-input-end")).toHaveLength(1)
        expect(response.finishReason.normalized).toBe("tool-calls")
      }),
    )
  }
})
