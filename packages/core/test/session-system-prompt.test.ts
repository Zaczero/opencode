import { expect, test } from "bun:test"
import { SessionSystemPrompt } from "@opencode-ai/core/session/system-prompt"

test("renders the default system prompt instructions", () => {
  const prompt = SessionSystemPrompt.make(["apply_patch", "read", "shell"])
  expect(prompt).not.toContain("${OPENCODE_TOOL_GUIDANCE}")
  expect(prompt).toContain("Use apply_patch to create, update, delete, or rename text files")
})
