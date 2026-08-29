import { isFallbackTitle } from "@opencode-ai/util/session-title-fallback"
import { SPINNER_FRAMES } from "../component/spinner-frames"

export function terminalTitle(title: string | undefined, working = false, frame = 0) {
  if (!title || isFallbackTitle(title)) return "OpenCode"
  const value = title.length > 40 ? title.slice(0, 37) + "…" : title
  if (working) return `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${value}`
  return `IDLE · ${value}`
}
