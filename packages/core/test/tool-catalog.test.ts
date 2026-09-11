import { expect } from "bun:test"
import { DateTime, Effect } from "effect"
import { OpenAIChat, OpenAIResponses, AnthropicMessages } from "@opencode-ai/ai/protocols"
import { Agent } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Location } from "@opencode-ai/core/location"
import { Plugin } from "@opencode-ai/core/plugin"
import { PluginInternal } from "@opencode-ai/core/plugin/internal"
import { SessionModelRequest } from "@opencode-ai/core/session/model-request"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { Tool } from "@opencode-ai/core/tool"
import { Session } from "@opencode-ai/schema/session"
import { Money } from "@opencode-ai/schema/money"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { offlineModels } from "./fixture/models"
import { codeModeListings, toolIdentity } from "./lib/tool"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([PluginInternal.requirements, Plugin.node, SessionModelRequest.node]), [
    Location.node.replace(tempLocationLayer),
    Config.node.replace(Config.testLayer()),
    offlineModels,
  ]),
)

it.live("offers one editing tool across model families and session parentage", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const internal = yield* PluginInternal.list()
    yield* plugins.activate(
      internal.pre
        .filter((plugin) => plugin.id.startsWith("opencode.tool.") || plugin.id.startsWith("opencode.prompt."))
        .map((plugin) => ({ ...plugin, revision: "test" })),
    )
    const registry = yield* Tool.Service
    const requests = yield* SessionModelRequest.Service
    const location = yield* Location.Service
    const tools = yield* registry.snapshot()
    expect(tools.definitions.some((tool) => tool.name === "apply_patch")).toBe(true)
    expect(tools.definitions.some((tool) => ["edit", "write", "patch"].includes(tool.name))).toBe(false)
    expect(
      codeModeListings(tools.codeModeCatalog ?? { tools: [] }).filter((tool) =>
        ["apply_patch", "edit", "write", "patch"].includes(tool.path),
      ),
    ).toEqual([])
    for (const name of ["edit", "write", "patch"]) {
      const error = yield* tools
        .execute({
          ...toolIdentity,
          sessionID: Session.ID.make("ses_tool_catalog"),
          call: { type: "tool-call", id: `call_${name}`, name, input: {} },
        })
        .pipe(Effect.flip)
      expect(error.message).toBe(`Unknown tool: ${name}`)
    }

    for (const model of [
      OpenAIResponses.route.model({ id: "gpt-5", provider: "test" }),
      OpenAIChat.route.model({ id: "gpt-4.1", provider: "test" }),
      AnthropicMessages.route.model({ id: "claude-sonnet-4", provider: "test" }),
      OpenAIChat.route.model({ id: "kimi-k2", provider: "test" }),
    ]) {
      for (const parentID of [undefined, Session.ID.make("ses_parent")]) {
        const session = Session.Info.make({
          id: Session.ID.make("ses_tool_catalog"),
          parentID,
          projectID: location.project.id,
          location: { directory: location.directory },
          cost: Money.USD.zero,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        })
        const prepared = yield* requests.prepare({
          kind: "primary",
          scope: {
            session,
            agentID: Agent.ID.make("build"),
            tools,
            model: SessionRunnerModel.resolved(model, {
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              cost: [],
              limit: { context: 100_000, output: 10_000 },
            }),
          },
          transcript: { system: [], messages: [] },
        })
        expect(
          prepared.request.tools
            ?.filter((tool) => ["apply_patch", "edit", "write", "patch"].includes(tool.name))
            .map((tool) => tool.name),
        ).toEqual(["apply_patch"])
      }
    }
  }),
)
