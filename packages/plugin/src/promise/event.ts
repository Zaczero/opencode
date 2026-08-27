import type { EventApi, OpenCodeEvent } from "@opencode-ai/client/promise"

type Subscribe = EventApi["subscribe"] & ((types?: readonly string[]) => AsyncIterable<OpenCodeEvent>)

export interface EventDomain {
  readonly subscribe: Subscribe
}
