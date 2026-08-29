import { isFallbackTitle } from "@opencode-ai/util/session-title-fallback"
import { SPINNER_FRAMES } from "../component/spinner-frames"

export function terminalTitle(title: string | undefined, working = false, frame = 0) {
  if (!title || isFallbackTitle(title)) return "OpenCode"
  const prefix = working ? SPINNER_FRAMES[frame % SPINNER_FRAMES.length] : "IDLE"
  return `${prefix} · ${title.length > 40 ? title.slice(0, 37) + "…" : title}`
}
