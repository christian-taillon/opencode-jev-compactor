# OpenCode Jev Compaction

Quality-first OpenCode v2 checkpoint compaction using TypeSafe Jev as a structured decision engine.

The plugin does not ask Jev to write a summary. OpenCode still decides when compaction runs and still installs the resulting checkpoint in the same session. The plugin intercepts the v2 `compaction` hook, asks Jev many narrow Noul / Choice / Score questions, composes keep / drop / truncate decisions in TypeScript, and builds a checkpoint only from retained transcript facts and verbatim evidence.

If the plugin cannot produce a valid useful checkpoint, it leaves `event.result` unset and OpenCode performs its normal local compaction.

## Compatibility

Version `0.0.4` targets **OpenCode 2.0.7** and pins `@opencode/plugin` to `2.0.7`. The server/TUI adapter was checked against the tagged 2.0.7 plugin contracts for RPC, storage, tools, session hooks, and TUI RPC calls.

The core compaction engine is deliberately isolated from OpenCode APIs, but the package adapter is version-sensitive. Run both `pnpm typecheck` and `pnpm test` after changing OpenCode/plugin versions.

## 0.0.4 design goal

The quality objective is not "make the checkpoint as small as possible." It is:

> Maximize useful retained information per frontier-model input token.

Jev is therefore used conservatively. A low relevance score alone is not enough to delete something. The policy must obtain affirmative evidence that an item is safe to discard.

For an unpinned tool item, Jev independently judges:

- whether the call still matters
- whether exact result evidence still matters
- whether it contains an unresolved blocker
- whether it establishes completed work
- whether losing it risks repeating work
- whether newer evidence supersedes it
- whether a short exact result prefix is sufficient
- whether the whole item is safe to discard
- a keep-full / truncate / drop Choice
- relevance to the current next move

Application code combines those answers. Ambiguous or low-confidence answers fail toward retaining information.

## OpenCode integration

This is a native OpenCode v2 plugin:

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "opencode.jev-compaction",
  async setup(ctx) {
    await ctx.session.hook("compaction", async (event) => {
      // ...
      event.result = { summary, metadata }
    })
  },
})
```

It does not use the v1 `experimental.session.compacting` API and does not create a replacement session.

On success:

```text
OpenCode native automatic/manual compaction
        -> v2 compaction hook
        -> Jev structured decisions
        -> deterministic checkpoint assembly
        -> event.result
        -> OpenCode installs native checkpoint
        -> same session continues
```

Earlier messages remain stored by OpenCode. The checkpoint changes active model context, not session identity or persisted transcript ownership.

## Install

Clone the repository and install its dependencies:

```sh
git clone git@github.com:christian-taillon/opencode-jev-compactor.git
cd opencode-jev-compactor
corepack pnpm install
```

Put the package in a location referenced by OpenCode, for example:

```text
repo/
  plugins/
    jev-compaction/
      index.ts
      tui.ts
      rpc.ts
      package.json
      src/
      ...
  opencode.jsonc
```

The root entrypoints support OpenCode's local-directory discovery while the package exports continue to target the source adapters.

Provide the TypeSafe key to the OpenCode server process. Do not write the key into `opencode.json(c)` or this repository:

```sh
export TYPESAFE_API_KEY='your-key-here'
```

Then configure it:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "compaction": {
    "auto": true,
    "keep": { "tokens": 15000 },
    "buffer": 30000
  },
  "plugins": [
    {
      "package": "./plugins/jev-compaction",
      "options": {
        "enabled": true,
        "keepThreshold": 0.45,
        "exactEvidenceThreshold": 0.45,
        "discardThreshold": 0.80,
        "supersededThreshold": 0.75,
        "uncertaintyMargin": 0.12,
        "minConfidence": 0.55,
        "preserveRecentMessages": 6,
        "minReductionRatio": 0.15,
        "toolResultPreviewChars": 8000,
        "truncateHeadChars": 600,
        "maxStateTokens": 28000,
        "timeoutMs": 6000,
        "enableCompareTool": true
      }
    }
  ]
}
```

The `compaction` block belongs to OpenCode, not this plugin. In particular, `buffer` controls how early native automatic compaction starts. `keep.tokens` controls the recent OpenCode tail retained beside a local checkpoint.

Local text compaction is OpenCode's default. If you explicitly configured provider-native compaction for a model/provider, set that route back to `mode: "local"` when you want this plugin to own checkpoint generation.

## User-facing options

### Quality policy

| Option | Default | Purpose |
| --- | ---: | --- |
| `enabled` | `true` | Configured default for Jev interception. Runtime TUI override can temporarily supersede it. |
| `keepThreshold` | `0.45` | Positive retention threshold for call usefulness, blockers, completion, repeat-work risk, and relevance. |
| `exactEvidenceThreshold` | `0.45` | Threshold at which exact tool result evidence forces full retention. |
| `discardThreshold` | `0.80` | High bar required for affirmative safe-to-discard and drop-choice evidence. |
| `supersededThreshold` | `0.75` | How certain Jev must be that newer information supersedes an item before that supports deletion. |
| `uncertaintyMargin` | `0.12` | Noul answers within this distance of 0.5 are treated as uncertain and retained conservatively. |
| `minConfidence` | `0.55` | Low-confidence Choice/Score answers cannot authorize deletion. |
| `preserveRecentMessages` | `6` | Hard-pins the newest N messages against plugin pruning. The first message and newest user request are also pinned. |
| `minReductionRatio` | `0.15` | Minimum estimated fraction removed before the plugin accepts its checkpoint. Otherwise OpenCode default compaction runs. |

Deletion is deliberately asymmetric. Keeping requires evidence that something may matter. Dropping requires stronger affirmative disposal proof.

### Jev state and result retention

| Option | Default | Purpose |
| --- | ---: | --- |
| `toolResultPreviewChars` | `8000` | Maximum initial exact prefix of each tool result included in Jev state. Full local result remains available for checkpoint reconstruction. |
| `truncateHeadChars` | `600` | Exact result prefix retained when policy selects truncate. No LLM rewriting is used. |
| `maxStateChars` | `110000` | Serialized state character safety limit. |
| `maxStateTokens` | `28000` | Estimated Jev state token limit before fallback. |
| `maxRequestTokens` | `60000` | Estimated request budget used to split independent Jev questions into concurrent batches. |
| `timeoutMs` | `6000` | Total decision window. Cancellation or timeout falls through to OpenCode. |
| `model` | `jev-latest` | TypeSafe System One model alias. |
| `baseUrl` | TypeSafe System One URL | Advanced override for compatible proxy/test endpoints. |

State fitting is internal rather than individually configurable. If needed it shortens Jev-only previews in this order: large tool results, tool inputs, then older assistant text. It never modifies the locally retained original transcript used to reconstruct exact evidence.

### Tools and observability

| Option | Default | Purpose |
| --- | ---: | --- |
| `enableCompareTool` | `true` | Advertise `jev_compare` to the agent for explicit two-item Choice/Score comparisons. |
| `historyLimit` | `10` | Number of compaction run-stat records retained in plugin storage. |
| `jevInputCostPerMillionUsd` | `0.042` | Input-only price used solely for the displayed estimated Jev cost. Change this if pricing changes. |

`jevInputCostPerMillionUsd` does not affect policy decisions.

## TUI controls

The package exports `./tui`, so OpenCode can load its TUI component alongside the configured server plugin.

Available commands:

```text
/jev-status    Show effective state, configured default, API-key state, last run, and bounded history.
/jev-toggle    Persistently toggle the running server plugin on/off.
/jev-reset     Clear the runtime override and return to options.enabled.
```

When disabled, the plugin simply leaves the compaction result unset. OpenCode's normal compaction path remains available.

The runtime toggle is stored in plugin-scoped server storage, not only in the terminal UI, so all TUI instances connected to that server observe the same state. `/jev-reset` prevents a forgotten runtime toggle from permanently masking a later configuration change.

For manual human compaction, use OpenCode's native `/compact` or its compaction keybind. Version 0.0.4 intentionally keeps manual compaction native.

## Agent-triggered compaction on OpenCode 2.0.7

OpenCode 2.0.7 exposes native `session.compact` through its client/API, but the public v2 server-plugin `SessionDomain` does not expose `compact()`. This package therefore does **not** advertise a `jev_compact` agent tool on 2.0.7.

This is intentional. The plugin does not call private server URLs, start another session, or misuse `session.command()` to imitate native compaction. Automatic compaction and the human `/compact` path still enter OpenCode's native compaction lifecycle and therefore still reach this plugin's `compaction` hook.

If a future supported `@opencode/plugin` version exposes `ctx.session.compact()`, an agent-triggered tool can be added without changing the core compaction engine.

## `jev_compare`

When enabled and `TYPESAFE_API_KEY` exists:

```text
jev_compare(left, right, criterion, context?)
```

It sends one small structured state plus independent Jev questions:

- Choice: left / right / tie
- Score: left relevance
- Score: right relevance

It returns structured JSON. It does not generate prose.

## Semantic acceptance gate

A smaller serialized checkpoint is not sufficient evidence that Jev performed useful compaction. Converting raw OpenCode message JSON into Markdown can reduce bytes and estimated tokens even when every meaningful item was retained.

Version 0.0.4 therefore accepts a Jev checkpoint only when the decisions perform at least one real semantic reduction:

- drop an eligible text block
- drop a tool item
- actually shorten a tool result with a truncate decision

If none of those occurs, the plugin returns `fallback (no-semantic-reduction)` and leaves `event.result` unset so OpenCode performs its normal local compaction.

The existing `minReductionRatio` remains a second size-efficiency gate after semantic reduction has been proven. Metrics report semantic actions separately from estimated serialized-size reduction.

## Previous checkpoints and weak follow-ups

Previous `<conversation-checkpoint>` content is parsed into structured baseline sections. On a later compaction, material before that checkpoint is not re-scored and the old checkpoint envelope is never copied verbatim into the new checkpoint. The baseline sections are merged with retained newer state.

Weak follow-ups such as `more`, `continue`, and `more more` are not treated as standalone objectives. Objective resolution is deterministic:

1. newest substantive user request
2. previous checkpoint objective
3. newest earlier substantive user request
4. otherwise fall back to native compaction with `weak-objective-unresolved`

Reasoning parts, system/control records such as effort metadata, raw checkpoint envelopes, and empty placeholder sections are excluded from generated checkpoints.

## Checkpoint construction

The checkpoint is assembled locally from retained facts:

```text
## Objective
## Constraints
## Files in play
## Decisions
## Completed
## Active work
## Next move
## Kept evidence
```

Retained user/assistant text is copied verbatim into fenced blocks. A full tool result is copied exactly. A truncated result contains the exact leading `truncateHeadChars` characters followed by a deterministic truncation marker. Unknown message-part types and attachment descriptors are retained conservatively.

Jev never writes replacement checkpoint prose.

## Fallback behavior

The plugin does not brick the session. It leaves `event.result` unset when:

- it is disabled
- `TYPESAFE_API_KEY` is absent
- the structured state cannot fit
- an individual question/request cannot fit
- TypeSafe is unavailable or times out
- the hook is cancelled
- the Jev payload is malformed or incomplete
- application composition fails
- everything payload-bearing is pinned and there is nothing useful to prune
- Jev makes no actual semantic reduction (`no-semantic-reduction`)
- a weak follow-up objective cannot be resolved (`weak-objective-unresolved`)
- estimated serialized reduction is below `minReductionRatio`

OpenCode then continues with its normal local compaction behavior.

### Large-session limitation in 0.0.4

Version 0.0.4 fits one shared Jev state before batching its questions. It does not yet split an oversized transcript into candidate-state windows. Very large transcripts can therefore report `fallback (state-cannot-fit)` without making a Jev request, after which OpenCode performs its normal local compaction. Raising the state limit is not a substitute for candidate-state chunking or multi-pass processing.

## More frequent compaction

Do not hide scheduling policy inside this plugin. OpenCode already owns the correct native scheduler.

For quality-first coding sessions, a reasonable starting experiment is:

```jsonc
{
  "compaction": {
    "auto": true,
    "keep": { "tokens": 15000 },
    "buffer": 30000
  }
}
```

A larger `buffer` starts automatic compaction earlier. Keep `keep.tokens` generous initially so recent literal context survives independently of the Jev checkpoint. Measure session quality before making it smaller.

## Metrics

Each run records only metrics, not Jev state contents:

- original estimated context tokens
- checkpoint estimated tokens
- estimated serialized fraction removed
- semantic reduction action count
- fitted state size and fitting stage
- Jev request count
- Jev input/output token usage
- Jev wall-clock latency
- estimated Jev input cost
- tools kept full / truncated / dropped
- text kept / dropped
- redaction count
- fallback reason

The latest run and bounded history are stored through `ctx.storage`; successful stats are also attached to `event.result.metadata`.

## Privacy and security

Only the fitted structured state is sent to TypeSafe. The plugin applies cheap best-effort redaction for common bearer tokens, OpenAI-style keys, GitHub tokens, AWS access-key IDs, private keys, and obvious password/token/key/secret assignments.

This is not a DLP guarantee. Do not use the plugin for a session whose contents cannot be sent to TypeSafe merely because the heuristic exists.

`TYPESAFE_API_KEY` is read from the process environment and is never logged or embedded in checkpoint metadata.

## Architecture

```text
src/
  index.ts                 OpenCode v2 server plugin
  tui.ts                   TUI status/toggle/reset controls
  rpc.ts                   typed server/TUI RPC contract
  plugin/options.ts        validated user options
  domain/                  I/O-free types
  transcript/              v2 normalization + checkpoint assembly
  state/                   Jev state, fitting, estimation, redaction
  jev/                     questions, batching, HTTP client, response parser
  policy/                  conservative retention composition + reduction gate
  compaction/              host-neutral orchestration
  tools/                   jev_compare
  observability/           logs and bounded metrics history

tests/
  fixtures/
  core.test.mjs
```

The raw OpenCode message shape is contained at the transcript boundary. Core policy can be tested without OpenCode running.

## Development

```sh
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm test
```

The test suite covers options, pinning, native v2 tool-message normalization, prior-checkpoint parsing, reasoning/control filtering, weak-objective resolution, semantic-reduction gating, configurable Jev previews, staged state fitting, secret redaction, conservative tool policy, disposal proof, uncertainty behavior, exact checkpoint retention, reduction gating, malformed Jev responses, tool-heavy pruning, already-short fallback, Jev failure fallback, state-too-large fallback, deterministic/idempotent decisions, and bounded metrics history.

## References

OpenCode v2:

- https://opencode.ai/v2/docs/build/plugins/
- https://opencode.ai/v2/docs/build/plugins/rpc/
- https://opencode.ai/v2/docs/build/plugins/cli/
- https://opencode.ai/v2/docs/build/plugins/migrate-v1
- https://opencode.ai/v2/docs/compaction/
- https://opencode.ai/v2/docs/plugins/
- https://opencode.ai/v2/docs/cli/plugins/
- https://opencode.ai/v2/docs/api/

TypeSafe / Jev:

- https://docs.typesafe.ai/introduction
- https://docs.typesafe.ai/concepts/system-one
- https://docs.typesafe.ai/concepts/state
- https://docs.typesafe.ai/concepts/how-to-build-with-system-one
- https://docs.typesafe.ai/primitives
- https://docs.typesafe.ai/primitives/choice
- https://docs.typesafe.ai/primitives/score
- https://docs.typesafe.ai/primitives/noul
- https://docs.typesafe.ai/api
- https://docs.typesafe.ai/models
