import { ClaudeCode } from "@opencode/ai/providers/claude-code"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Model } from "../../model.js"
import { Provider } from "../../provider.js"
import { Variant } from "../../variant.js"

const providerID = Provider.ID.make("claude-code")
const anthropic = Provider.ID.make("anthropic")
const packageID = "@opencode/ai/providers/claude-code"

// Reading the model picker starts Claude Code once; every Location of the process shares the answer.
const resolved = new Map<string, ReturnType<typeof ClaudeCode.models>>()

/**
 * Claude models billed to the Claude Code subscription: exactly the models Claude Code's own picker offers, including
 * versionless aliases (`opus`, `sonnet`, …) that follow the newest model Claude Code serves, so no list is kept here
 * and a release needs no catalog update. Each carries its concrete model ID, whose Anthropic catalog entry supplies
 * limits, capabilities, and variants.
 */
export const make = (env: Readonly<Record<string, string | undefined>> = process.env) =>
  define({
    id: "opencode.provider.claude-code",
    effect: Effect.fn(function* (ctx) {
      const executable = Bun.which("claude", { PATH: env.PATH })
      const account = yield* Effect.promise(() => ClaudeCode.account(env))
      if (!executable || !account) return
      const key = JSON.stringify([executable, env.CLAUDE_CONFIG_DIR])
      const models = yield* Effect.promise(() => {
        const pending = resolved.get(key) ?? ClaudeCode.models(executable, env).catch(() => [])
        resolved.set(key, pending)
        return pending
      })
      // A failed resolution is retried by the next boot or reload rather than remembered.
      if (models.length === 0) return void resolved.delete(key)
      yield* ctx.provider.transform((providers) => {
        const source = providers.get(anthropic)
        providers.update(providerID, (provider) => {
          provider.name = "Claude Code"
          provider.activation = "enabled"
          provider.package = packageID
          provider.integrationID = undefined
          provider.settings = Provider.mergeOverlay({ account, executable }, provider.settings)
        })
        for (const offered of models) {
          const exact = source?.models.get(Model.ID.make(offered.model))
          // A catalog that has not caught up with a release Claude Code already serves lends its newest model of the
          // same family until it does.
          const base = exact ?? newest([...(source?.models.values() ?? [])], offered.model)
          providers.models.update(providerID, Model.ID.make(offered.id), (draft) => {
            if (base) Object.assign(draft, structuredClone(base))
            Object.assign(draft, {
              providerID,
              id: Model.ID.make(offered.id),
              modelID: Model.ID.make(offered.model),
              package: undefined,
              cost: [],
            })
            if (!exact) {
              draft.name = offered.name
              draft.variants = [...Variant.resolve({ ...draft, package: packageID })]
            }
          })
        }
      })
      // Provider definitions are shared by every Location; model edits are Location-local. Claude Code runs in
      // the session's directory so its own environment context agrees with OpenCode's, and shares the auto memory
      // of the main checkout, as Claude Code does in a worktree.
      yield* ctx.model.transform((editor) => {
        for (const model of editor.list(providerID))
          editor.update(providerID, model.id, (draft) => {
            draft.settings = Provider.mergeOverlay(draft.settings, {
              directory: ctx.location.directory,
              project: ctx.location.project.canonical,
            })
          })
      })
    }),
  })

const version = (id: string) => /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/.exec(id)

/** The highest undated version of `concrete`'s family in the catalog. */
const newest = (models: readonly Model.Info[], concrete: string) => {
  const family = version(concrete.replace(/-\d{8}$/, ""))?.[1]
  return models
    .flatMap((model) => {
      const match = version(model.id)
      return match && match[1] === family ? [{ model, rank: Number(match[2]) * 100 + Number(match[3] ?? 0) }] : []
    })
    .sort((a, b) => b.rank - a.rank)[0]?.model
}

export const ClaudeCodePlugin = make()
