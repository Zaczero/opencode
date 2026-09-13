import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { OpenCode } from "@opencode-ai/client/promise"
import { contextUsage } from "@opencode-ai/client/context-usage"
import { loadRunReferences, runProviders } from "../../src/mini/catalog.shared"
import { catalogModel, catalogProvider } from "./fixture/catalog"

afterEach(() => {
  mock.restore()
})

describe("run catalog shared", () => {
  test("preserves the server compaction threshold for mini usage", () => {
    const model = catalogModel({ id: "model", providerID: "provider", name: "Model" })
    const providers = runProviders(
      [catalogProvider("provider", "Provider")],
      [{ ...model, limit: { context: 200_000, output: 32_000, compaction: 120_000 } }],
    )
    expect(
      contextUsage(
        { input: 120_001, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        providers[0].models.model.limit,
      ),
    ).toEqual({ tokens: 120_001, percent: 100 })
  })
  test("loads visible project references from the current reference catalog", async () => {
    const client = OpenCode.make({ baseUrl: "https://opencode.test" })
    const list = spyOn(client.reference, "list").mockImplementation(
      () =>
        Promise.resolve({
          location: { directory: "/tmp", project: { id: "proj_1", directory: "/tmp" } },
          data: [
            {
              name: "effect",
              path: "/repos/effect",
              description: "Effect v4 sources",
              source: { type: "local", path: "/repos/effect" },
            },
            {
              name: "secret",
              path: "/repos/secret",
              hidden: true,
              source: { type: "local", path: "/repos/secret" },
            },
          ],
        }) as never,
    )

    const references = await loadRunReferences(client, { directory: "/tmp" })

    expect(list).toHaveBeenCalledWith({ location: { directory: "/tmp" } })
    expect(references).toMatchObject([{ name: "effect", path: "/repos/effect", description: "Effect v4 sources" }])
  })

  test("merges current providers and models into the footer catalog shape", () => {
    const providers = runProviders(
      [catalogProvider("openai", "OpenAI")],
      [
        catalogModel({
          id: "gpt-5",
          modelID: "openai",
          providerID: "openai",
          name: "Little Frank",
          variants: ["high"],
        }),
      ],
    )

    expect(providers).toEqual([
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-5": {
            name: "Little Frank",
            cost: {
              input: 0,
            },
            limit: {
              context: 128_000,
            },
            status: "active",
            variants: {
              high: {},
            },
          },
        },
      },
    ])
  })
})
