# OpenCode Jev Compaction

OpenCode v2 compaction guidance using TypeSafe Jev as a structured decision engine.

The plugin does not ask Jev to write a summary. OpenCode decides when compaction runs. The plugin intercepts the native `compaction` hook, asks Jev narrow typed questions once, applies deterministic safety policy in TypeScript, and then uses one of two delivery modes:

- **`guided-native` (default):** append a small operator-authored guidance message after the existing transcript and let OpenCode's native frontier model write the final structured summary.
- **`deterministic`:** skip the frontier summary request and install the plugin's deterministic checkpoint directly through `event.result`.

The default is intentionally cache-friendly. In `guided-native`, the existing compaction transcript is not rewritten before the native model request. The plugin only appends guidance, so providers that support prefix caching can continue matching the unchanged historical prefix.

If Jev cannot make a useful decision safely, the plugin leaves the request alone and OpenCode performs normal compaction.

## Compatibility

Version `0.0.8` targets **OpenCode 2.0.14** and pins `@opencode/plugin` to `2.0.14`.

After changing OpenCode or the plugin SDK, run:

```sh
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm test
```

## 0.0.8 design

The objective is:

> Improve compaction quality while preserving provider prompt-cache reuse and keeping Jev as a single decision stage.

### Default flow

```text
OpenCode session.compaction
        ↓
normalize transcript
        ↓
resolve current objective
        ↓
deterministic pruning-capacity preflight
        ↓
fit chronological Jev state
        ↓
ONE Jev decision stage
        ↓
deterministic keep / provenance-only / stale policy
        ↓
append compact guidance after the existing transcript
        ↓
OpenCode appends its native summary prompt
        ↓
frontier model writes the final structured summary
```

The existing transcript is not physically pruned in `guided-native`. Jev tells the native summarizer which tool evidence is stale or only needs provenance. This preserves the old request prefix rather than replacing historical messages immediately before the compaction request.

### One Jev stage

Jev is always one decision stage.

For each eligible tool call, the plugin asks independent Noul questions over one shared chronological state. Request-budget batching can split those questions into multiple API requests, but answers from one request are never used to construct another Jev judgment.

There is no destructive-action verification round.

### Deterministic safety policy

Application code decides what Jev is allowed to classify as removable.

| Policy | Examples | Jev may recommend |
| --- | --- | --- |
| `pin_full` | `question`, `skill`, `subagent`, unknown tools, incomplete calls, failed results, pinned/recent calls | Nothing; full evidence stays protected |
| `protect_call` | `write`, `edit`, `patch`, `shell`, `execute`, web fetch/search | Preserve action/provenance; raw result may be summarized away |
| `drop_eligible` | `read`, `grep`, `glob`, `find`, `list`, `ls` | Full keep, provenance-only, or omit stale repeatable evidence |

Unknown tools fail toward full retention.

For `drop_eligible` tools the plugin asks:

1. Is retaining the call/input still necessary for the current objective?
2. Is retaining the exact full result still necessary?

For `protect_call` tools it asks only the second question because code already decided that provenance must remain.

The default `keepThreshold` is `0.15`. Equality keeps. A destructive recommendation therefore requires a retention probability below the threshold.

### Cache-friendly native guidance

A successful `guided-native` run appends one chronological system message after the existing conversation and before OpenCode's native summary prompt.

The guidance contains only bounded tool identifiers and names. It never includes raw tool inputs or results.

Conceptually:

```text
<existing cached transcript>
<jev-compaction-guidance>
  omit stale repeatable calls A/B
  preserve only provenance for C/D
</jev-compaction-guidance>
<OpenCode native summary prompt>
```

The plugin does **not** alter `event.system` and does **not** rewrite earlier `event.messages` in this mode.

This is designed to preserve provider prefix-cache reuse. Actual cache behavior remains provider-specific and should be measured from real usage.

### Native summary remains valuable

OpenCode's native compaction model already produces a concise structured checkpoint with sections for objective, requirements, decisions, work state, next move, relevant files, and important context.

Jev's role in the default design is to improve what the summarizer treats as important, especially high-volume tool evidence, rather than replacing the summarizer.

### Deterministic comparison mode

Set:

```jsonc
"delivery": "deterministic"
```

to use the previous behavior:

```text
Jev decisions
    ↓
deterministic checkpoint assembly
    ↓
event.result
    ↓
native model summary skipped
```

This mode remains available for A/B testing. It preserves retained text exactly but can produce a larger durable checkpoint because it does not semantically summarize user/assistant prose.

### Native baseline

Disable the plugin with `/jev-toggle` or `"enabled": false` to measure ordinary OpenCode compaction with no Jev involvement.

Together, these provide three useful local comparison modes:

1. native OpenCode
2. Jev `guided-native`
3. Jev `deterministic`

### Chronological Jev state

Jev receives an ordered projection with the resolved current objective, previous structured checkpoint baseline, conversational text, tool inputs, result status/size, and a small exact result preview.

The local transcript is not changed while fitting the Jev state.

When needed, fitting progressively shortens tool inputs, abridges old text, collapses old unpinned text, compacts old tool traces, removes old call-less entries from the Jev-only state, and merges adjacent compacted call runs.

### Deterministic pruning-capacity preflight

Before Jev is called, the plugin computes the maximum semantic payload that the tool policy could possibly remove or de-emphasize.

If even the best possible keep/provenance/drop outcome cannot satisfy `minReductionRatio`, the plugin falls through to native OpenCode compaction with:

```text
insufficient-prunable-payload
```

and spends zero Jev tokens.

Protected-call results already shorter than `truncateHeadChars` are also excluded from Jev questions because reducing them would have no meaningful effect.

### Semantic action gate

The plugin measures transcript payload independently of JSON/Markdown representation:

```text
user/assistant text
+ tool input
+ tool result
+ attachment descriptors
```

Jev guidance or a deterministic checkpoint is used only when:

- at least one real tool action is identified, and
- the tool policy could remove/de-emphasize at least `minReductionRatio` of semantic payload.

Otherwise OpenCode native compaction runs unchanged.

## OpenCode integration

OpenCode 2.0.14 invokes the plugin's `session.compaction` hook before it appends its own native summary prompt.

In `guided-native`:

```ts
await ctx.session.hook("compaction", async (event) => {
  event.messages = [...event.messages, guidanceMessage]
  // event.result intentionally remains unset
})
```

OpenCode then appends its normal summary instruction and sends the frontier-model compaction request.

In `deterministic`:

```ts
event.result = {
  summary: deterministicCheckpoint,
  metadata
}
```

which skips the frontier-model summary request.

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
        "delivery": "guided-native",
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

The `compaction` block belongs to OpenCode. Keep `keep.tokens` generous while evaluating quality.

## Options

| Option | Default | Purpose |
| --- | ---: | --- |
| `enabled` | `true` | Configured default for Jev interception. |
| `delivery` | `guided-native` | `guided-native` appends cache-friendly guidance and lets OpenCode summarize; `deterministic` installs the plugin checkpoint directly. |
| `model` | `jev-latest` | TypeSafe System One model alias. |
| `keepThreshold` | `0.15` | Retention probability threshold. Equality keeps. |
| `preserveRecentMessages` | `6` | Pins the newest N messages. The first message and newest user request are also pinned. |
| `minReductionRatio` | `0.15` | Minimum semantic payload fraction worth targeting with Jev. |
| `toolResultPreviewChars` | `300` | Small exact result prefix included in the Jev state. |
| `truncateHeadChars` | `600` | Deterministic retained prefix and protected-result usefulness threshold. |
| `maxStateChars` | `100000` | Jev-state character safety ceiling. |
| `maxStateTokens` | `24000` | Jev-state token-estimate ceiling. |
| `maxRequestTokens` | `30000` | State + question request budget. |
| `maxConcurrentRequests` | `2` | Maximum concurrent independent Jev batches. |
| `timeoutMs` | `6000` | Total Jev decision window. |
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

Reasoning parts, system/control records, raw checkpoint envelopes, and empty placeholder sections are excluded from the Jev state.

## Deterministic checkpoint construction

The `deterministic` delivery mode still supports exact checkpoint assembly:

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

Conversation text is copied verbatim. Full tool results are copied exactly. Reduced results contain the exact leading `truncateHeadChars` characters plus a deterministic omission marker.

The same candidate checkpoint is still calculated in `guided-native` mode for diagnostics, but it is not installed.

## Fallback behavior

The plugin leaves the native request unchanged when, among other cases:

- disabled
- TypeSafe key missing
- objective cannot be resolved
- no tool evidence is eligible
- maximum possible tool reduction is too small
- fitted state/request cannot fit
- TypeSafe fails, times out, or returns malformed data
- Jev identifies no semantic action

OpenCode then performs its normal compaction.

## TUI diagnostics

```text
/jev-status
/jev-toggle
/jev-reset
```

`/jev-status` reports:

- loaded plugin version and delivery mode
- OpenCode Location/plugin instance
- compaction hook/request counters
- fitted Jev state size/stage
- maximum prunable payload
- Jev request count/input tokens/latency/cost
- keep/provenance/drop decisions
- guided-native guidance size/item count
- projected deterministic checkpoint size

Historical 0.0.5 verification probabilities remain readable, but 0.0.8 never generates verification requests.

## Local comparison

For the next live test, use the same representative long session and compare:

### 1. Native OpenCode

Disable Jev:

```text
/jev-toggle
/compact
```

Record OpenCode compaction input/cache-read/cache-write/output usage and resulting checkpoint size.

### 2. Guided native

Enable Jev with:

```jsonc
"delivery": "guided-native"
```

Restart the plugin/server as needed, run `/compact`, then record:

- `/jev-status`
- Jev input tokens/cost
- OpenCode compaction cache read/write/input/output
- final native checkpoint size
- continuation quality

### 3. Deterministic

Set:

```jsonc
"delivery": "deterministic"
```

Run the same test. The frontier summary request should be skipped. Compare the deterministic checkpoint size and continuation behavior against the guided-native result.

The most useful metric is total cost and continuation quality through the next compaction, not merely the number of tokens removed at the compaction boundary.

## Privacy

Only the fitted single-pass Jev state is sent to TypeSafe. Best-effort secret redaction is applied before that state leaves the plugin.

The guided-native instruction contains only sanitized tool IDs/names and coarse keep/provenance/drop actions. It does not copy tool inputs or outputs.

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
