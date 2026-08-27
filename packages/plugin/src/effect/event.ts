import type { EventApi, OpenCodeEvent } from "@opencode/client/effect"
import type { Stream } from "effect"

type Subscribe = EventApi<unknown>["subscribe"] & ((types?: readonly string[]) => Stream.Stream<OpenCodeEvent, unknown>)

export interface EventDomain {
  readonly subscribe: Subscribe
}
