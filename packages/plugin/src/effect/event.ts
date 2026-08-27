import type { OpenCodeEvent } from "@opencode-ai/client/effect"
import type { Stream } from "effect"

export interface EventDomain {
  readonly subscribe: (types?: readonly string[]) => Stream.Stream<OpenCodeEvent, unknown>
}
