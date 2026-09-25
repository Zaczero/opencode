- After changing the public Protocol or Server `HttpApi`, run `bun run generate` from `packages/client`. Do not edit generated client files directly.
- Keep runtime dependencies directed from Schema to Core and Protocol, then from Core and Protocol to Server. Client runtime code may depend on Schema and Protocol but never Core or Server; `sdk` composes Client, Core, and Server.
- Current implementation changes belong in `packages/core`, `packages/cli`, `packages/server`, `packages/protocol`, `packages/schema`, and related generated client surfaces when required.
- This repository does not use Changesets. Do not add `.changeset` files; follow the existing release workflow instead.
- The default branch in this repo is `v2`.
- Default new branches and worktrees to `v2`, or `origin/v2` when the local `v2` ref is unavailable, and default pull requests to target `v2`. Use another base or target branch when the requester explicitly instructs it.
- Local `main` ref may not exist; use `v2` or `origin/v2` for diffs.

## Live V2 TUI Testing

- Run `bun run dev:live` from a development worktree to test its TUI against the currently elected `opencode` background server and live sessions.
- Pass a directory after the script when needed, for example `bun run dev:live /path/to/project`.
- The script discovers the server with `opencode service status`, injects its private local credential from `opencode service get password`, and uses the `dev` TUI storage channel so tabs and other client-local state match the installed client.
- Prefer `dev:live` over plain `bun run dev` for this workflow. An implicit managed-service connection may replace the live server when the worktree client version differs; explicit `--server` warns and continues without replacing it.

## V2 TUI Stories

- When a user asks for a TUI story, add a fixture-driven story under `packages/tui/src/feature-plugins/system/storybook` and register it in `index.tsx`.
- Render the real production component rather than a visual copy. Keep submissions and other side effects local to the story so it is safe to explore repeatedly.
- Expose the meaningful state dimensions through story keybindings and list them in `StoryFooter`; include a reset command when combinations can leave the fixture in a confusing state.
- Run a specific story with `OPENCODE_STORY=<story-id> bun run dev:live` from the development worktree, and exercise narrow and wide terminal sizes when layout is relevant.

## TUI Theme Tokens

- Choose theme tokens by semantic role, not by their current color. Do not use raw `theme.hue` values or borrow an unrelated semantic token to achieve a preferred appearance.
- Use `text.feedback` and `background.feedback` only for outcome or status feedback such as errors, warnings, success messages, and informational messages. Use `formfield` states for form-control text, ordinals, and selection markers, and `action` states for actions.
- If the theme does not expose a token for the required semantic role, extend the theme schema, defaults, resolution, and types with that role before using it in a component. Do not repurpose the nearest-looking existing token.
- When changing the public theme token surface, verify the built-in light and dark defaults and the custom-theme fallback path in addition to the affected TUI component.

## Branch Names

Use a short branch name of at most three words, separated by hyphens. Do not use slashes or type prefixes such as `feat/` or `fix/`.

Examples: `session-recovery`, `fix-scroll-state`, `regenerate-sdk`.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful, e.g. `core`, `opencode`, `tui`, `app`, `desktop`, `sdk`, or `plugin`.

Examples: `fix(tui): simplify thinking toggle styling`, `docs: update contributing guide`, `chore(sdk): regenerate types`.

## Fork History

Each commit is cherry-pickable and carries one complete feature or bug fix, including
its tests, generated artifacts, and required guidance. Fold corrections into the
owning commit; do not append follow-up or integration commits for the same feature.
A commit that repairs, extends, or only speeds up another fork commit's feature
belongs in that commit; audit the series for such pairs on every rewrite. Keep
independent changes in separate commits, and give each a body that says why.

Refresh the fork onto the newest upstream release tag. Re-apply each commit's intent
to the new base rather than replaying its text: drop what upstream now resolves,
adapt to changed upstream seams, and carry repeated optimizations to new sister
sites. Preserve upstream ancestry. A fix to upstream-owned behavior may remain a
standalone fork commit. Verify the final tree and range-diff after rewriting;
publish an authorized rewrite with an explicit `--force-with-lease=<ref>:<expected-sha>`.
Use the Conventional Commit style above, not the NixOS repository's commit style.

Installing a distribution does not authorize restarting the shared service or an
existing TUI. Those restarts require explicit user approval.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Validate unknown values once at the boundary that owns them. Pass typed values inward instead of repeating `typeof value === "object"` and property-existence checks. Do not defensively revalidate values already guaranteed by a schema, constructor, or internal type.
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Before adding complexity for a speculative or vanishingly unlikely race or security edge case, explain the concrete failure mode, likelihood, and complexity cost to the user and get their buy-in. Do not silently expand scope for theoretical robustness.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.
- In Effect generators, bind services to named variables before calling methods. Do not use nested service yields such as `yield* (yield* Foo.Service).bar()`.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Imports

- Never alias imports. Do not use `import { foo as bar } from "..."` or renamed imports like `resolve as pathResolve`.
- Never use type-position `import("...")` references such as `Schema.declare<import("@opencode/plugin/effect/plugin").Plugin["effect"]>`. Only when two imports genuinely collide on a name and no other option exists, an aliased type import (`import type { Plugin as PluginDefinition } from "..."`) is permitted as a last resort — still strongly preferred not to.
- Never use star imports. Do not use `import * as Foo from "..."` or `import type * as Foo from "..."`.
- If a namespace-style value is needed, import the module's own exported namespace by name, for example `import { Project } from "@opencode/core/project"`, then reference `Project.ID`.
- Prefer dynamic imports for heavy modules that are only needed in selected code paths, especially in startup-sensitive entrypoints. Destructure dynamic import bindings near the top of the narrowest scope that needs them so they read like normal imports. Avoid inline chains such as `await import("./module").then((mod) => mod.value())` or `(await import("./module")).value()`. Keep branch-specific imports inside the branch that needs them to preserve lazy loading.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Do not return `Effect` from helpers unless they actually perform effectful work. Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible, you shouldn't be using globalThis.\* at all unless it's the only option.
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package directories such as `packages/core`.
- In `packages/core`, run `bun run test [files]`. Its `script/test.ts` wrapper isolates
  `HOME`, XDG roots, and credentials. Direct `bun test` loads the developer's plugins;
  the host's shell policy can then reject test commands before they start.
- TUI tests also need isolated `HOME` and XDG roots when invoked locally. A real
  global TUI plugin changes the plugin picker and can make lifecycle assertions
  select the wrong entry. Run `bun test` with an empty environment plus `PATH`,
  temporary `HOME`/XDG roots, `TERM=xterm-256color`, and `TZ=UTC`.

## Checks

- Run `bun run check` from the repository root as the canonical full lint and type-check verification.
- During focused iteration, run `bun typecheck` from the affected package directory (for example, `packages/core`). Never run `tsc` directly.

## V2 Session Core

- Background shells and result readers retain their Location until completion; notification observers belong to the process-global Job service. Preserve that lifetime separation across plugin reload and Location expiry. `Job.activeSessions` includes unacknowledged `job.background/` KV records, so an empty shell registry does not establish that all background work has been acknowledged. Session deletion retires both owned jobs and notifications referring to the deleted child.
- Keep durable events minimal: record irreducible new facts and do not repeat state derivable by folding the ordered aggregate history. Enrich projections and read models with previous or derived state when consumers need self-contained views.
- Keep durable prompt admission separate from model execution. `Session.prompt(...)` publishes `session.inbox.enqueued`, whose projection inserts one durable `session_inbox` row, before scheduling advisory `SessionExecution.wake(sessionID)` unless `resume: false` requests admit-only behavior. Delivery publishes `session.inbox.delivered`; its projection consumes the inbox row and inserts the visible message in the same transaction. `session_inbox` stores only unconsumed work.
- Reusing a Session ID adopts the existing Session. Reusing a user or synthetic inbox item ID is idempotent when Session and type match: the first admission wins and the retried payload, metadata, and delivery mode are ignored, whether the item is still pending or already delivered (reconciled from the projected message without retained enqueue history). Cross-Session or cross-type reuse fails. Control items keep their operation-specific conflict behavior. A synthetic payload may instead name a `slot`, where the newest admission wins: it withdraws the Session's still-pending synthetic in that slot, so a producer reporting a recurring snapshot keeps one undelivered entry carrying current state instead of a queue of stale ones. Delivered items have already left `session_inbox` and are never withdrawn.
- Bound the retained compaction suffix by `compaction.keep.tokens`. Each assistant
  message contains its tool calls and results, so retaining complete messages does
  not require widening to the previous user prompt. Truncate synthetic shell output
  like foreground tool output, preserving its job identity, log path, and exit status.
- Local compaction uses the selected Session model and its ordinary structured
  request prefix. Compaction hooks may override the final `prompt`; append that
  instruction after hooks and disable tool choice while retaining definitions.
  Context-transforming plugins must register for both `context` and `compaction`
  to preserve their prefix.
- Model responses expose `limit.compaction` from `SessionCompaction.threshold`; its
  state changes refresh the catalog. Context meters share the Client's
  `context-usage` helper, round up, and clamp at 100%. The numerator is reported
  usage, counted through `TokenUsage.contextTokens`: the provider's reported context
  size replaces billed input when one response bills several passes. Automatic
  compaction anchors on the same count and also estimates content added since.
- Only root sessions expose `question`; children report decisions to their parent.
  `subagent_interrupt` targets direct children, cancels their background shells, and
  distinguishes a settled stop from an interrupt still awaiting cleanup. Cancelled
  shells do not wake their session; cancelled subagent jobs notify their parent.
- `Tool.Info.format` carries a raw-input grammar through `ToolDefinition.format`.
  OpenAI Responses uses custom tools; other routes retain JSON function encoding.
  Keep advertisement, streaming, tool choice, and history replay consistent.
  `apply_patch` uses this contract with `patchText` as its string input property;
  the existing TUI canonicalizes its name to `patch`.
- Keep `SessionExecution` process-global and Session-ID based. Its local implementation owns the process-local Session coordinator and discovers placement through `SessionStore` plus `LocationServiceMap.get(session.location)` only when a drain starts; no layer should take a Session ID. V2 interruption targets the active process-local ownership chain for that Session; interruption of a known but idle or locally unowned Session is a no-op, while the public API rejects an unknown Session.
- Keep `SessionRunner`, model resolution, tool registry, permissions, and filesystem Location-scoped. Omitted `Location.workspaceID` means implicit-local placement; explicit workspace identity remains reserved for future placement semantics.
- Preserve one explicit `llm.stream(request)` call per Physical Attempt and reload projected history before durable continuation. A logical Step may use generic pre-output retries, one full-context retry after continuation rejection, incomplete-stream continuation, or one overflow-compaction rebuild. Generic retries retain the logical step number and do not consume another agent-step allowance. Do not delegate orchestration to an in-memory tool loop.
- Bind provider state to the account captured for each outbound request. `ModelResolver`
  retains the resolved credential snapshot; `ModelAccount` derives an opaque scope from
  that identity and its route. Assistant and compaction projections preserve the scope,
  including across forks. Missing or mismatched provenance excludes opaque state while
  retaining readable history. Prompt-cache keys hash the Session's cache affinity
  (parent, else fork source, else itself) with that scope. The automatic-compaction
  estimate anchors only on usage reported under the current scope. Late HTTP request
  hooks make identity unknown, so those requests omit opaque history and cache keys.
  Provider model-request hooks must use their supplied credential snapshot, rather
  than reselecting an account after model resolution.
- Keep local Session drains process-local until clustering is implemented. `SessionRunCoordinator` joins explicit same-Session resumes, coalesces prompt wakeups, and allows different Sessions to run concurrently. A write-ahead execution claim marks a process-local busy period for restart recovery: terminal completion, failure, or user interruption releases it, while shutdown interruption and process death preserve it. Startup recovery resumes claimed top-level Sessions with durable per-execution attempt accounting. The claim is a recovery marker, not clustered ownership, fencing, or an exactly-once guarantee.
- Keep native compaction mechanisms out of `SessionCompaction`. Plugins register `native` strategies through the `SessionCompaction` editor that turn a prepared request into a replacement window (the built-in `NativeCompactionPlugin` handles `@opencode/ai` compaction operations); later registrations win. Core owns the provider-mode decision, route provenance, the retry policy, overflow recovery, interruption, usage accounting, and checkpoint persistence.
- Keep delivery vocabulary explicit. Prompts steer by default. At safe step boundaries, steered compaction takes priority up to the first steered move control; other steers retain enqueue order. At an idle boundary, steers take priority; otherwise exactly one queued item delivers before the runner reevaluates continuation. Inbox items may be cancelled or changed between queue and steer before delivery. Promoting new user input resets the selected agent's step allowance; a batch of steers resets it once.
- One step is one logical LLM call; its durable record covers only the model-visible span. Do not write "provider turn", and do not use bare "turn" for a single call: "turn" is reserved for the future assistant-turn unit containing all steps from prompt promotion until the session would go idle.
- Keep event replay ownership separate from clustered Session execution ownership.
- Keep the Instructions algebra and built-ins in `src/instructions`; keep instruction producers with their observed domains, and keep Session History selection plus `InstructionState` and `InstructionEntry` persistence Session-owned. `InstructionDiscovery` observes ambient global and upward-project instructions. The runner composes built-ins, discovery, guidance, and entries explicitly in `loadInstructions`; there is no instruction registry.
- Keep the built-in environment heading distinct from Claude Code's preamble; the
  `claude-code` route sends this prompt through Claude Code's subscription login.
  With Agent SDK 0.2.141 and Claude Code 2.1.268, a captured system prompt using
  "Here is some useful information about the environment you are running in:"
  returned the third-party extra-usage HTTP 400; changing only that line to
  "# Execution environment" succeeded. Preserve the environment data and identity.
- `session.instructions.updated` stores changed source keys and content hashes and may freeze rendered chronological update text. Blob values live once in `instruction_blob`; the projected `instruction_state` row is the normal boundary-processing source of current and initial values. Request assembly renders the epoch baseline from stored values, while later frozen updates enter history as durable System messages. Completed compaction moves the instruction epoch; Session movement retains it so destination instruction changes are chronological, while committed revert clears it. Forks adopt the parent's newest instruction values even when copied message history ends at an earlier boundary. Unavailable sources retain the last value and block only the initial complete delta.

## Claude Code Route

- `claude-code` (`packages/ai/src/providers/claude-code.ts`) reuses the Anthropic Messages protocol with an Agent SDK transport. Each logical model step starts one Claude Code process that performs exactly one model call; OpenCode keeps the loop, tools, permissions, compaction, instructions, and plugins. Tools are advertised through an inert in-process MCP server (`CLAUDE_AGENT_SDK_MCP_NO_PREFIX` keeps OpenCode's names) and execute only in OpenCode from the streamed `tool_use`, except web search.
- Web search is Claude Code's own. When the request carries OpenCode's provider-search tool `web_search` (offered to `claude-code` sessions and ChatGPT subscriptions; other models use the `websearch` integration), the transport enables Claude Code's built-in `WebSearch` instead of advertising it. Claude Code answers the call with its own side request (Anthropic's server search on the session's model) before the step ends. The call streams as a provider-run `web_search` and the step's closing frames wait for a result block carrying Claude Code's exact result text and links; replay restores Claude Code's own `tool_use`/`tool_result` form. The step finishes at `tool-calls` with the result unread, so the runner continues; each OpenCode step still makes one model call.
- The whole lowered conversation is materialized as a Claude Code transcript under the login's `projects/<cwd key>/`, resumed with `resumeSessionAt` at its last entry, and completed by an empty prompt; delivering the newest message as the prompt instead re-attaches its images as saved files and rewrites its text, and without `resumeSessionAt` Claude Code adds its own reply and repair entries. Adjacent same-role messages are merged first because Claude Code joins them with an inserted newline. The SDK `sessionStore` resume path is avoided: it copies credentials into a temporary config where a token refresh would diverge. After the step, Claude Code is closed and awaited (it flushes the transcript and its session registration while exiting), then the transcript is removed.
- The child environment keeps only the login's `CLAUDE_CONFIG_DIR` from inherited `CLAUDE*`, `ANTHROPIC_*`, `MAX_THINKING_TOKENS`, and `DISABLE_PROMPT_CACHING*` variables, which would otherwise override effort, inject body fields, or reroute credentials. Fixed switches disable Claude Code's compaction, retries, non-streaming fallback, tool deferral and description truncation, auto memory (with its recall, extraction, and dreaming), CLAUDE.md, connectors, and reminders, and enable the advisor, which Claude Code otherwise leaves off here despite the login's rollout flag. Request fields Claude Code cannot send, including body overlays and forced tool choice, are refused; `tool_choice: none` stays advisory so the cached prefix keeps its tools. Omitted thinking is sent as disabled and omitted effort as the API default, not Claude Code's per-model defaults.
- Claude Code announces attachments in its transcript: per-turn `environment`, `model`, `session_context`, and `date`, the advisor's availability (`advisor_tool`, beside its deferred definition), and any a later Claude Code adds; without a prior copy it appends them after the newest message with the only message cache breakpoint, so no rebuilt transcript would reuse the cached conversation. Each conversation (login, executable, directory, model, OpenCode Session, and first turn) keeps the attachments it started with at its start, and every later announcement (a new date, an environment update, any other attachment) anchored after the turn it followed, re-materialized there on each step as Claude Code's own transcript keeps them; replacing the start instead would re-cache the whole conversation daily. Anchors carry the hash of the conversation up to them, so a revert or compaction that rewrites that span drops them. The state is a small file per conversation under the login's `opencode/` directory, read on every step, so a restart rebuilds the same transcript; files idle for 30 days are pruned. New conversations start from the latest state announcements (per-turn context and advisor availability) seen for their login, directory, and model. The environment block cannot be disabled without bare mode, which drops OAuth, so Claude Code runs in the session's Location directory and states it truthfully. Claude Code chooses the cache TTL itself: 1 hour on the subscription.
- Assistant entries carry the request model (Claude Code drops thinking attributed to another model) and the effort in force from OpenCode's effort markers. Claude Code lays effort out its own way, a marker before each assistant turn and the current effort at the top level, which governs every turn with the same effort and keeps the cached prefix across an effort switch. `claude-code` models disable native mid-conversation system updates and thinking block binding. Claude Code orders tools by name and adds `context_management: clear_thinking keep:"all"`; the recorder suite fixes every other difference at zero.
- Failures Claude Code reports classify through the shared HTTP classifier from its observed status and error code; a rejected subscription limit supplies its reset time as the retry delay. A process that ends before responding is a `process` transport failure carrying Claude Code's stderr tail; one that ends mid-response is an incomplete stream.
- The advisor is Claude Code's: a stronger model reviews the whole conversation inside the same response. The transport follows the login's own `advisorModel` from its `settings.json` (Claude Code's `/advisor`; Claude Code otherwise runs without user settings here) and Claude Code skips it for a session model more capable than the advisor. Its call and opaque result (`advisor_redacted_result`) stream as a provider-run `advisor` call and replay in API form; Claude Code strips them itself from a request without the advisor. Usage counts only the session model's iterations: the advisor reads the context uncached, billed to its own model, and stays in the raw usage.
- Auto memory is the login's native store (`autoMemoryDirectory`, else `projects/<main checkout key>/memory/`, shared with Claude Code sessions in the project; the plugin supplies the main checkout as `project`), rendered by the route: Claude Code adds its memory section only to its default system prompt, and would rebuild it in every step's process, so a memory saved mid-conversation would re-cache the whole conversation. Each conversation stores the section, with the first 200 lines of `MEMORY.md` as Claude Code loads them, in its state file on its first step and appends that same text to the system prompt on every later one, as Claude Code keeps its section for a session; the next conversation sees what was saved. Claude Code's recall, extraction, and dreaming are not reproduced. The login's `autoMemoryEnabled: false` turns it off.
- The account identity is the non-secret `oauthAccount` organization and account UUID from Claude Code's `.claude.json`, supplied as the configured `account` setting; tokens stay with Claude Code. The transport refuses to run when the live login differs from the identity the model was resolved for. Identity, transcripts, seeds, and session identities are keyed by the login's config directory (`configDirectory`, defaulting to the inherited `CLAUDE_CONFIG_DIR`), and `ModelAccount` scopes opaque history and cache affinity by the identity; the plugin currently publishes the inherited login, and further accounts are further config directories, each with its own provider entry.
- Claude Code reports a session identity upstream (`x-claude-code-session-id`, `metadata.user_id`). It is derived from `x-opencode-session` and the login, so a conversation keeps one identity per account across steps; a concurrent request in the same Session takes the next derived identity because each step owns its transcript file. Anthropic prompt caching has no client key; OpenCode governs it through prefix stability.
- The catalog is Claude Code's own model picker, read once per process through the SDK's `supportedModels()` without a model call, so Claude Code decides which models exist and what its versionless aliases (`opus`, `sonnet`, …) resolve to, and a release needs no catalog update here. Claude Code's context-window suffix (`opus[1m]`, `claude-opus-5-5[1m]`) is stripped: the row identifies the model, and the protocol, variants, and catalog key on concrete API IDs. The `anthropic` catalog entry for the concrete ID supplies limits, capabilities, variants, and name at zero cost; for a release the catalog has not reached yet, its newest same-family entry stands in and Claude Code's display name is used. Explicit `providers["claude-code"]` config, including `limit.compaction`, applies on top.
- The SDK (`@anthropic-ai/claude-agent-sdk`) is pinned exactly; the route starts the installed `claude`. The installed Claude Code updates itself, so a new release reaches the route without a fork change. After an SDK upgrade, or when a new Claude Code release changes behavior, run `packages/ai/test/provider/claude-code.test.ts`, which drives the bundled binary against a recording Messages endpoint, and recheck a live two-step session's cache reads.
