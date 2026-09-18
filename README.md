# OpenCode Jev Compaction

Quality-first OpenCode v2 checkpoint compaction using TypeSafe Jev as a structured decision engine.

The plugin does not ask Jev to write a summary. OpenCode decides when compaction runs and installs the resulting checkpoint in the same session. The plugin intercepts the v2 `compaction` hook, asks Jev narrow typed questions, combines the answers in TypeScript, and reconstructs a checkpoint from retained transcript evidence.

If the plugin cannot produce a useful checkpoint safely, it leaves `event.result` unset and OpenCode performs its normal local compaction.

## Compatibility

Version `0.0.5` targets **OpenCode 2.0.7** and pins `@opencode/plugin` to `2.0.7`.

The OpenCode adapter is version-sensitive. After changing OpenCode or `@opencode/plugin`, run:

```sh
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm test
```

## 0.0.5 design

The objective remains:

> Maximize useful retained information per frontier-model input token.

The 0.0.5 architecture intentionally simplifies the Jev workload.

### Preserve conversation text, prune tool traces

User and assistant text is preserved verbatim by default. Jev focuses on the high-volume context that is usually safest to prune in coding sessions: tool calls and tool results.

For each unpinned tool call with a result, the first pass asks only two independent Noul questions:

1. Does knowing this call happened, including its input, still matter for continuation, provenance, completed-work memory, or avoiding repeated work?
2. Does the exact full result still need to remain verbatim?

Application code maps those judgments to a provisional action:

```text
keep result
    -> keep call + full result

drop full result, keep call
    -> candidate truncate

drop result and call
    -> candidate drop
```

Every provisional truncate/drop then receives a second destructive-action verification with richer candidate evidence. A destructive action is accepted only when verification reaches `verificationThreshold`. Uncertain or failed verification keeps the full item.

### Chronological Jev state

Jev receives an ordered conversation projection rather than separate text/tool arrays:

```json
{
  "goal": "current resolved objective",
  "baseline": { "objective": "...", "sections": {} },
  "history": [
    {
      "role": "assistant",
      "text": "Reading the adapter.",
      "tool_calls": [
        {
          "id": "t1",
          "name": "read",
          "input": "{...}",
          "result": {
            "status": "ok",
            "chars": 18427,
            "preview": "small exact prefix..."
          }
        }
      ]
    }
  ]
}
```

This preserves chronology so Jev can see that an earlier read/test/error was superseded by later work.

### Jev-only state fitting

The local transcript remains untouched. Only the decision state sent to Jev is made smaller.

When needed, fitting progressively:

1. truncates tool inputs to 1000, then 200, then 60 characters
2. abridges long old text to head + tail
3. collapses old unpinned text to an omission marker
4. reduces old tool calls to one-line summaries
5. removes old call-less entries from the Jev state
6. merges runs of old call-only entries

This should substantially reduce `state-cannot-fit` cases before candidate-state chunking is introduced.

### Semantic reduction gate

A JSON-to-Markdown size change is never treated as evidence of successful compaction.

The acceptance metric is calculated over semantic transcript payload:

```text
user/assistant text
+ tool input
+ tool result
+ attachment descriptors
```

The plugin accepts its checkpoint only when:

- at least one tool result is actually truncated or a tool item is dropped
- semantic payload removed is at least `minReductionRatio`

Serialized checkpoint reduction is still recorded for diagnostics, but does not authorize success.

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

Automatic and manual `/compact` use OpenCode's native compaction lifecycle. The plugin does not create a replacement session.

## Install

```sh
git clone git@github.com:christian-taillon/opencode-jev-compactor.git
cd opencode-jev-compactor
corepack pnpm install
```

For local development, point OpenCode directly at the checkout or symlink the checkout into the OpenCode plugin directory. Ensure only one server copy is loaded.

Provide the TypeSafe key to the OpenCode server process:

```sh
export TYPESAFE_API_KEY='your-key-here'
```

Example configuration:

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

        "keepThreshold": 0.50,
        "verificationThreshold": 0.80,
        "uncertaintyMargin": 0.12,

        "preserveRecentMessages": 6,
        "minReductionRatio": 0.15,

        "toolResultPreviewChars": 300,
        "verificationResultPreviewChars": 8000,
        "truncateHeadChars": 600,

        "maxStateChars": 100000,
        "maxStateTokens": 24000,
        "maxRequestTokens": 30000,
        "timeoutMs": 6000,

        "enableCompareTool": true,
        "historyLimit": 10
      }
    }
  ]
}
```

The `compaction` block belongs to OpenCode, not this plugin. Keep `keep.tokens` generous while evaluating checkpoint quality.

## Options

| Option | Default | Purpose |
| --- | ---: | --- |
| `enabled` | `true` | Configured default for Jev interception. |
| `keepThreshold` | `0.50` | First-pass probability at which call/result information is retained. |
| `verificationThreshold` | `0.80` | Required probability before a destructive truncate/drop is accepted. |
| `uncertaintyMargin` | `0.12` | Noul answers near 0.5 fail toward full retention. |
| `preserveRecentMessages` | `6` | Hard-pins the newest N messages. The first message and newest user request are also pinned. |
| `minReductionRatio` | `0.15` | Minimum semantic payload fraction that must actually be removed. |
| `toolResultPreviewChars` | `300` | Small result prefix included in the first-pass Jev state. |
| `verificationResultPreviewChars` | `8000` | Richer candidate result prefix used only for destructive verification. |
| `truncateHeadChars` | `600` | Exact prefix retained when a result is truncated. |
| `maxStateChars` | `100000` | Jev state character ceiling before fallback. |
| `maxStateTokens` | `24000` | Jev state token-estimate ceiling. |
| `maxRequestTokens` | `30000` | State + question budget used for batching. |
| `timeoutMs` | `6000` | Total compaction decision window. |
| `model` | `jev-latest` | TypeSafe System One model alias. |
| `historyLimit` | `10` | Number of run records retained in plugin storage. |
| `jevInputCostPerMillionUsd` | `0.042` | Display-only Jev input-cost estimate. |

## Previous checkpoints and weak follow-ups

Previous `<conversation-checkpoint>` content is parsed into structured baseline sections. Material before that checkpoint is not re-scored or copied back as a raw envelope.

Weak follow-ups such as `more`, `continue`, and `more more` are not standalone objectives. Objective resolution is:

1. newest substantive user request
2. previous checkpoint objective
3. newest earlier substantive user request
4. otherwise native fallback with `weak-objective-unresolved`

Reasoning parts, system/control records such as effort metadata, raw checkpoint envelopes, and empty placeholder sections are excluded.

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
- nothing tool-related is eligible for pruning
- fitted state/request cannot fit
- TypeSafe fails, times out, or returns malformed data
- no semantic reduction is made
- semantic payload reduction is below `minReductionRatio`

OpenCode then uses normal local compaction.

If a compaction hook arrives with `event.result` already populated, 0.0.5 records `preexisting-compaction-result` instead of silently returning. This is useful for detecting duplicate plugin loading or another compaction plugin handling the event first.

## TUI controls and diagnostics

```text
/jev-status
/jev-toggle
/jev-reset
```

`/jev-status` reports:

- session ID and plugin version for the last run
- serialized reduction for diagnostics
- semantic payload before/after and actual semantic reduction
- first-pass and verification request counts
- Jev tokens, latency, and estimated cost
- tools kept/truncated/dropped
- bounded per-tool decisions with keep-call, keep-result, and verification probabilities
- fallback reason

## `jev_compare`

When enabled, `jev_compare(left, right, criterion, context?)` remains available as an independent TypeSafe comparison tool. It is unrelated to checkpoint pruning.

## Large sessions

0.0.5 still uses one shared fitted state for the first-pass questions. The more aggressive chronological-state fitting should handle substantially larger transcripts than 0.0.4. Candidate-state chunking remains a later step if real sessions still hit `state-cannot-fit`.

## Privacy

Only fitted state and targeted verification evidence are sent to TypeSafe. Best-effort redaction is applied to both first-pass state and richer verification evidence.

This is not a DLP guarantee.

## Development

```sh
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm test
```

The core is isolated from OpenCode APIs so normalization, fitting, Jev policy, checkpoint construction, semantic reduction, and failure behavior can be unit tested independently.

## References

- https://docs.typesafe.ai/introduction
- https://docs.typesafe.ai/concepts/how-to-build-with-system-one
- https://docs.typesafe.ai/concepts/state
- https://docs.typesafe.ai/primitives/noul
- https://docs.typesafe.ai/api
- https://opencode.ai/v2/docs/compaction/
- https://opencode.ai/v2/docs/build/plugins/
