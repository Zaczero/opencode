/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { SidebarContext } from "../../src/feature-plugins/sidebar/context"

function context(options?: { cost?: number; tokens?: number; limit?: { context: number; compaction?: number } }) {
  const color = RGBA.fromInts(200, 200, 200)
  return {
    theme: { text: { base: color, muted: color } },
    data: {
      session: {
        get: () => ({ location: { directory: "/workspace" } }),
        cost: () => options?.cost ?? 0,
        message: {
          list: () =>
            options?.tokens
              ? [
                  {
                    id: "message",
                    type: "assistant",
                    model: { providerID: "provider", id: "model" },
                    tokens: {
                      input: options.tokens,
                      output: 0,
                      reasoning: 0,
                      cache: { read: 0, write: 0 },
                    },
                  },
                ]
              : [],
        },
      },
      location: {
        model: {
          list: () => (options?.limit ? [{ providerID: "provider", id: "model", limit: options.limit }] : []),
        },
      },
    },
  } as unknown as Context
}

test("sidebar omits context before usage is available", async () => {
  const app = await testRender(() => <SidebarContext context={context()} sessionID="session" />, {
    width: 42,
    height: 8,
  })

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Context")
    expect(app.captureCharFrame()).not.toContain("Not measured")
  } finally {
    app.renderer.destroy()
  }
})

test("sidebar shows available context usage", async () => {
  const app = await testRender(() => <SidebarContext context={context({ tokens: 1234 })} sessionID="session" />, {
    width: 42,
    height: 8,
  })

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Context")
    expect(app.captureCharFrame()).toContain("1,234 tokens")
  } finally {
    app.renderer.destroy()
  }
})

test.each([
  { tokens: 401, percent: 51 },
  { tokens: 800, percent: 100 },
  { tokens: 801, percent: 100 },
])("sidebar displays $percent% for $tokens tokens against the compaction threshold", async ({ tokens, percent }) => {
  const app = await testRender(
    () => (
      <SidebarContext context={context({ tokens, limit: { context: 1_000, compaction: 800 } })} sessionID="session" />
    ),
    { width: 42, height: 8 },
  )
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(`${tokens} tokens`)
    expect(app.captureCharFrame()).toContain(`${percent}% used`)
  } finally {
    app.renderer.destroy()
  }
})
