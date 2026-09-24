# OpenCode Jev Compaction

OpenCode v2 checkpoint compaction using TypeSafe Jev as a structured decision engine.

The plugin does not ask Jev to write a summary. OpenCode decides when compaction runs. The plugin intercepts the native `compaction` hook, asks Jev narrow typed questions once, applies deterministic safety policy in TypeScript, and reconstructs a checkpoint from retained transcript evidence.

If the plugin cannot produce a useful checkpoint safely, it leaves `event.result` unset and OpenCode performs its normal compaction.

## Compatibility

Version `0.0.6` targets **OpenCode 2.0.14** and pins `@opencode/plugin` to `2.0.14`.

After changing OpenCode or the plugin SDK, run:

```sh
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm test
```

## 0.0.6 design

The objective is:

> Maximize useful retained information per frontier-model input token.

### One Jev pass

Jev is always a single decision stage.

For each eligible tool call, the plugin asks independent Noul questions over one shared chronological state. Request-budget batching can split those questions into multiple API requests, but answers from one request are never used to construct a second Jev judgment.

There is no destructive-action verification round.

### Deterministic safety policy

Application code decides what Jev is allowed to destroy.

| Policy | Examples | Allowed outcome |
| --- | --- | --- |
| `pin_full` | `question`, `skill`, `subagent`, unknown tools, incomplete calls, failed results, pinned/recent calls | Keep full call and result |
| `protect_call` | `write`, `edit`, `patch`, `shell`, `execute`, web fetch/search | Keep call/input; Jev may keep or truncate the result |
| `drop_eligible` | `read`, `grep`, `glob`, `find`, `list`, `ls` | Jev may keep, truncate, or drop call + result |

Unknown tools fail toward full retention. This makes new or unrecognized tool classes safe by default.

For `drop_eligible` tools the plugin asks:

1. Is retaining the call/input still necessary for the current objective?
2. Is retaining the exact full result still necessary?

For `protect_call` tools it asks only the second question because code has already decided provenance must stay.

The default `keepThreshold` is `0.15`. Equality keeps. A destructive action therefore requires a retention probability below the threshold.

### Decision mapping

```text
pin_full
    -> keep full

protect_call
    keepResult >= threshold
        -> keep full
    otherwise
        -> keep call + truncate result

drop_eligible
    keepResult >= threshold
        -> keep full

    keepCall >= threshold
        -> keep call + truncate result

    otherwise
        -> drop call + result
```

### Preserve conversation text

User and assistant text remains verbatim by default. Jev focuses on high-volume tool traces. This avoids asking a decision model to rewrite or summarize user intent, decisions, constraints, or course corrections.

### Chronological Jev state

Jev receives an ordered projection with the resolved current objective, previous structured checkpoint baseline, conversational text, tool inputs, result status/size, and a small exact result preview.

The local transcript is not changed while fitting the Jev state.

When needed, fitting progressively shortens tool inputs, abridges old text, collapses old unpinned text, compacts old tool traces, removes old call-less entries from the Jev-only state, and merges adjacent compacted call runs.

### Semantic reduction gate

A JSON-to-Markdown representation change is never enough to declare success.

The plugin measures retained semantic payload:

```text
user/assistant text
+ tool input
+ tool result
+ attachment descriptors
```

A custom checkpoint is accepted only when:

- at least one real semantic action occurs, and
- removed semantic payload is at least `minReductionRatio`.

Otherwise OpenCode native compaction takes over.

## OpenCode integration

The plugin uses the native OpenCode v2 compaction lifecycle:

```ts
await ctx.session.hook("compaction", async (event) => {
  // ...
  event.result = { summary, metadata }
})
```

Automatic compaction and human `/compact` stay in the same OpenCode session.

## Install

```sh
git clone git@github.com:christian-taillon/opencode-jev-compactor.git
cd opencode-jev-compactor
corepack pnpm install
```

Point OpenCode at the checkout or symlink it into the OpenCode plugin directory. Ensure only one server copy is loaded.

Provide the TypeSafe API key to the OpenCode server process:

```sh
export TYPESAFE_API_KEY='your-key-here'
```

Example:

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
      "package": "/home/you/github/opencode-jev-compactor",
      "options": {
        "enabled": true,
        "model": "jev-latest",
        "keepThreshold": 0.15,
        "preserveRecentMessages": 6,
        "minReductionRatio": 0.15,
        "toolResultPreviewChars": 300,
        "truncateHeadChars": 600,
        "maxStateChars": 100000,
        "maxStateTokens": 24000,
        "maxRequestTokens": 30000,
        "maxConcurrentRequests": 2,
        "timeoutMs": 6000,
        "enableCompareTool": true,
        "historyLimit": 10
      }
    }
  ]
}
```

The `compaction` block belongs to OpenCode. Keep `keep.tokens` generous while evaluating checkpoint quality.

## Options

| Option | Default | Purpose |
| --- | ---: | --- |
| `enabled` | `true` | Configured default for Jev interception. |
| `model` | `jev-latest` | TypeSafe System One model alias. |
| `keepThreshold` | `0.15` | Retention probability threshold. Equality keeps. |
| `preserveRecentMessages` | `6` | Pins the newest N messages. The first message and newest user request are also pinned. |
| `minReductionRatio` | `0.15` | Minimum semantic payload fraction that must actually be removed. |
| `toolResultPreviewChars` | `300` | Small exact result prefix included in the Jev state. |
| `truncateHeadChars` | `600` | Exact prefix retained when a result is truncated. |
| `maxStateChars` | `100000` | Jev-state character safety ceiling. |
| `maxStateTokens` | `24000` | Jev-state token-estimate ceiling. |
| `maxRequestTokens` | `30000` | State + question request budget. |
| `maxConcurrentRequests` | `2` | Maximum concurrent first-pass batches. |
| `timeoutMs` | `6000` | Total compaction decision window. |
| `historyLimit` | `10` | Number of run records retained in plugin storage. |
| `jevInputCostPerMillionUsd` | `0.042` | Display-only Jev input-cost estimate. |

The 0.0.5 options `verificationThreshold`, `verificationResultPreviewChars`, and `uncertaintyMargin` are obsolete and ignored.

## Previous checkpoints and weak follow-ups

Previous `<conversation-checkpoint>` content is parsed into structured baseline sections. Material before that checkpoint is not re-scored or copied back as a raw envelope.

Weak follow-ups such as `more`, `continue`, and `more more` are not standalone objectives. Objective resolution is:

1. newest substantive user request
2. previous checkpoint objective
3. newest earlier substantive user request
4. otherwise native fallback with `weak-objective-unresolved`

Reasoning parts, system/control records, raw checkpoint envelopes, and empty placeholder sections are excluded.

## Checkpoint construction

Jev never writes replacement prose. The plugin deterministically assembles:

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

Conversation text is copied verbatim. Full tool results are copied exactly. Truncated results contain the exact leading `truncateHeadChars` characters plus a deterministic omission marker.

## Fallback behavior

The plugin leaves `event.result` unset when, among other cases:

- disabled
- TypeSafe key missing
- objective cannot be resolved
- no tool evidence is eligible for pruning
- fitted state/request cannot fit
- TypeSafe fails, times out, or returns malformed data
- no semantic reduction is made
- semantic payload reduction is below `minReductionRatio`

OpenCode then uses normal compaction.

## TUI diagnostics

```text
/jev-status
/jev-toggle
/jev-reset
```

`/jev-status` reports the loaded plugin instance, OpenCode Location, compaction hook/request counters, last historical run, semantic reduction, Jev request count/input tokens/latency/cost, and bounded per-tool decisions.

Historical 0.0.5 records can still display their old verification probabilities, but 0.0.6 never generates verification requests.

## Privacy

Only the fitted single-pass state is sent to TypeSafe. Best-effort secret redaction is applied before that state leaves the plugin.

This is not a DLP guarantee.

## Development

```sh
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm test
```

## References

- https://docs.typesafe.ai/introduction
- https://docs.typesafe.ai/concepts/how-to-build-with-system-one
- https://docs.typesafe.ai/concepts/state
- https://docs.typesafe.ai/primitives/noul
- https://docs.typesafe.ai/api
- https://opencode.ai/v2/docs/compaction/
- https://opencode.ai/v2/docs/build/plugins/
