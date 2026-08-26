import { describe, expect, test } from "bun:test"
import { Message, ToolResultPart } from "@opencode/ai"
import { boundImages, unsupportedParts } from "@opencode/core/session/model-request"

const capabilities = (input: string[]) => ({ tools: true, input, output: ["text"] })

describe("SessionModelRequest.unsupportedParts", () => {
  test("replaces unsupported user media with a visible error", () => {
    const messages = unsupportedParts(
      [
        Message.user([
          Message.text("Describe these files"),
          { type: "media", mediaType: "image/png", data: "aGVsbG8=", filename: "logo.png" },
          { type: "media", mediaType: "application/pdf", data: "JVBERg==", filename: "document.pdf" },
        ]),
      ],
      capabilities(["text"]),
    )

    expect(messages[0]?.content).toEqual([
      Message.text("Describe these files"),
      Message.text('ERROR: Cannot read "logo.png" (this model does not support image input). Inform the user.'),
      Message.text('ERROR: Cannot read "document.pdf" (this model does not support pdf input). Inform the user.'),
    ])
  })

  test("replaces unsupported media nested in tool results", () => {
    const messages = unsupportedParts(
      [
        Message.tool(
          ToolResultPart.make({
            id: "call_1",
            name: "read",
            result: {
              type: "content",
              value: [
                { type: "text", text: "Image read successfully" },
                { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "logo.png" },
              ],
            },
          }),
        ),
      ],
      capabilities(["text"]),
    )

    expect(messages[0]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          {
            type: "text",
            text: 'ERROR: Cannot read "logo.png" (this model does not support image input). Inform the user.',
          },
        ],
      },
    })
  })

  test("preserves supported media", () => {
    const message = Message.user({ type: "media", mediaType: "image/png", data: "aGVsbG8=" })
    expect(unsupportedParts([message], capabilities(["text", "image"]))[0]).toBe(message)
  })

  test("normalizes plain messages inserted by hooks", () => {
    const messages = unsupportedParts(
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      capabilities(["text"]),
    )

    expect(messages[0]).toBeInstanceOf(Message)
  })

  test("preserves supported nested files", () => {
    const message = Message.tool(
      ToolResultPart.make({
        id: "call_1",
        name: "read",
        result: {
          type: "content",
          value: [{ type: "file", uri: "file:///tmp/logo.png", mime: "image/png", name: "logo.png" }],
        },
      }),
    )

    const result = unsupportedParts([message], capabilities(["text", "image"]))

    expect(result[0]).toBe(message)
    expect(result[0]?.content[0]).toBe(message.content[0])
  })

  test("does not mutate messages when replacing nested files", () => {
    const message = Message.tool(
      ToolResultPart.make({
        id: "call_1",
        name: "read",
        result: {
          type: "content",
          value: [{ type: "file", uri: "file:///tmp/logo.png", mime: "image/png", name: "logo.png" }],
        },
      }),
    )
    const originalContent = message.content
    const originalPart = message.content[0]
    if (originalPart?.type !== "tool-result" || originalPart.result.type !== "content")
      throw new Error("Expected tool result")
    const originalValue = originalPart.result.value

    const result = unsupportedParts([message], capabilities(["text"]))

    expect(result[0]).not.toBe(message)
    expect(message.content).toBe(originalContent)
    expect(message.content[0]).toBe(originalPart)
    expect(originalPart.result.value).toBe(originalValue)
    expect(originalPart.result.value).toEqual([
      { type: "file", uri: "file:///tmp/logo.png", mime: "image/png", name: "logo.png" },
    ])
  })
})

describe("SessionModelRequest.boundImages", () => {
  test("preserves images below the trigger", () => {
    const messages = [Message.user({ type: "media", mediaType: "image/png", data: "aGVsbG8=" })]
    expect(boundImages(messages)).toBe(messages)
  })

  test("replaces oldest images until the retained payload reaches the target", () => {
    const image = "a".repeat(9 * 1024 * 1024)
    const messages = [
      Message.user({ type: "media", mediaType: "image/png", data: image, filename: "first.png" }),
      Message.user({ type: "media", mediaType: "image/png", data: image, filename: "second.png" }),
      Message.user({ type: "media", mediaType: "image/png", data: image, filename: "third.png" }),
    ]
    const result = boundImages(messages)

    expect(result[0]?.content[0]).toMatchObject({ type: "text" })
    expect(result[1]?.content[0]).toMatchObject({ type: "text" })
    expect(result[2]?.content[0]).toMatchObject({ type: "media", filename: "third.png" })
  })

  test("replaces images nested in tool results", () => {
    const image = "a".repeat(13 * 1024 * 1024)
    const result = boundImages([
      Message.tool(
        ToolResultPart.make({
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "file", uri: `data:image/png;base64,${image}`, mime: "image/png", name: "first.png" },
              { type: "file", uri: `data:image/png;base64,${image}`, mime: "image/png", name: "second.png" },
            ],
          },
        }),
      ),
    ])

    expect(result[0]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [{ type: "text" }, { type: "file", name: "second.png" }],
      },
    })
  })
})
