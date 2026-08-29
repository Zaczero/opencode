import { expect, test } from "bun:test"
import { SPINNER_FRAMES } from "../../src/component/spinner-frames"
import { terminalTitle } from "../../src/util/terminal-title"

test("uses the shared active spinner and an explicit idle title", () => {
  expect(terminalTitle("Compile project")).toBe("IDLE · Compile project")
  for (const frame of SPINNER_FRAMES)
    expect(terminalTitle("Compile project", true, SPINNER_FRAMES.indexOf(frame))).toBe(`${frame} Compile project`)
})
