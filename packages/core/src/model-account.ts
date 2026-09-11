export * as ModelAccount from "./model-account.js"

import type { LanguageModel } from "@opencode-ai/ai"
import type { Credential } from "./credential.js"
import { Hash } from "@opencode-ai/util/hash"

/** Non-secret credential identity; OAuth refresh preserves the saved account. */
export function identity(credential: Credential.Value | undefined, savedID?: Credential.ID) {
  if (!credential) return
  if (credential.type === "key")
    return credential.key ? Hash.sha256(JSON.stringify(["key", credential.key])) : undefined
  const account = credential.metadata?.accountID ?? savedID
  if (typeof account !== "string" || account.length === 0) return
  return Hash.sha256(JSON.stringify(["oauth", credential.methodID, savedID, account]))
}

const telemetry = new Set([
  "user-agent",
  "x-session-affinity",
  "x-session-id",
  "session-id",
  "x-parent-session-id",
  "x-opencode-project",
  "x-opencode-session",
  "x-opencode-client",
  "originator",
])

/** Endpoint and routing headers distinguish account scopes even within one provider. */
export function scope(identity: string | undefined, model: LanguageModel, headers?: Readonly<Record<string, string>>) {
  if (!identity || typeof model.route.endpoint.baseURL !== "string" || model.route.headers) return
  const routing = new Headers(model.route.defaults.http?.headers)
  for (const values of [model.defaults?.http?.headers, headers])
    for (const [name, value] of Object.entries(values ?? {})) routing.set(name, value)
  return Hash.sha256(
    JSON.stringify([
      model.provider,
      identity,
      model.route.id,
      model.route.endpoint.baseURL,
      model.route.endpoint.query,
      Array.from(routing)
        .filter(([name]) => !telemetry.has(name))
        .sort(([a], [b]) => a.localeCompare(b)),
    ]),
  )
}
