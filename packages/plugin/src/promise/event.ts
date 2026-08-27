import type { EventApi } from "@opencode-ai/client/promise/api"

export interface EventDomain {
  readonly subscribe: (
    options?: NonNullable<Parameters<EventApi["subscribe"]>[0]> & { readonly types?: readonly string[] },
  ) => ReturnType<EventApi["subscribe"]>
}
