import type { ModelInfo, SessionMessageAssistant, SessionMessageInfo } from "./promise/generated/types.js"

export function lastAssistantWithUsage(messages: ReadonlyArray<SessionMessageInfo>, boundary?: string) {
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1
  if (boundary && boundaryIndex === -1) return undefined
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex
  const compactionIndex = messages.findLastIndex(
    (message, index) => message.type === "compaction" && message.status === "completed" && index < end,
  )
  return messages.findLast(
    (message, index): message is SessionMessageAssistant & { tokens: NonNullable<SessionMessageAssistant["tokens"]> } =>
      message.type === "assistant" && message.tokens !== undefined && index > compactionIndex && index < end,
  )
}

export function contextUsage(
  tokens: NonNullable<SessionMessageAssistant["tokens"]>,
  limit?: Pick<ModelInfo["limit"], "context" | "compaction">,
) {
  const total = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  const ceiling = limit?.compaction ?? (limit && limit.context > 0 ? limit.context : undefined)
  return {
    tokens: total,
    percent:
      ceiling === undefined
        ? undefined
        : ceiling <= 0
          ? 100
          : Math.min(100, Math.max(0, Math.ceil((100 * total) / ceiling))),
  }
}
