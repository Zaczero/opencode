import type { OpenCodeEvent } from "@opencode-ai/client/promise"

export interface EventDomain {
  readonly subscribe: (types?: readonly string[]) => AsyncIterable<OpenCodeEvent>
}
