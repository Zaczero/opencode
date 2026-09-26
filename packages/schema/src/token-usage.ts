export * as TokenUsage from "./token-usage.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
  /** The last request's input size, reported when it differs from the billed input. */
  context: Schema.Finite.pipe(optional),
}).annotate({ identifier: "TokenUsage.Info" })

export function total(tokens: Info) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

/**
 * The context the next request starts from: the last request's input plus what the step generated. A response that
 * samples more than once (a call its advisor answers mid-response) bills the input of every pass, so the reported
 * size of the last one replaces the billed input.
 */
export function contextTokens(tokens: Info) {
  return (tokens.context ?? tokens.input + tokens.cache.read + tokens.cache.write) + tokens.output + tokens.reasoning
}
