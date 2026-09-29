# Local validation and benchmark

This document is the pre-merge/runtime validation plan for OpenCode Jev Compaction 0.0.8.

The goal is not simply to maximize bytes removed. The goal is to compare **total cost, prompt-cache behavior, checkpoint size, and continuation quality** across the available compaction paths.

## Preconditions

The repository checkout should be current and green:

```sh
cd /home/christian/github/opencode-jev-compactor
git switch main
git pull

corepack pnpm install
corepack pnpm run typecheck
corepack pnpm test
```

The OpenCode server process needs:

```sh
export TYPESAFE_API_KEY='...'
```

The recommended OpenCode global config location is:

```text
~/.config/opencode/opencode.jsonc
```

Point the plugin directly at the checkout:

```jsonc
{
  "plugins": [
    {
      "package": "/home/christian/github/opencode-jev-compactor",
      "options": {
        "enabled": true,
        "delivery": "observe",
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

Keep native OpenCode compaction scheduling unchanged while comparing modes:

```jsonc
"compaction": {
  "auto": true,
  "keep": { "tokens": 15000 },
  "buffer": 30000
}
```

Restart the OpenCode server/service after changing plugin code or configuration.

## Choose a representative session

Prefer a real, long coding session with:

- several read/grep/glob operations
- at least one shell or mutation operation
- completed work that should not be repeated
- exact identifiers, file paths, errors, or commands worth preserving
- a current objective that changed at least once
- enough context for native compaction to be meaningful

For a fair comparison, fork from the same user-turn boundary before compaction rather than using `/undo` as a selective checkpoint remover.

## Mode 0: native baseline

Disable Jev:

```text
/jev-toggle
```

Confirm:

```text
/jev-status
```

Then:

```text
/compact
```

Record:

- selected compaction model
- input tokens
- cache-read tokens
- cache-write tokens, when the provider reports them
- output tokens
- latency
- final checkpoint/continuation size
- whether the next response preserves key facts
- unnecessary tool re-runs or re-reading

This is the baseline.

## Mode 1: observe

Set:

```jsonc
"delivery": "observe"
```

Enable Jev and restart the service.

Observe mode runs the complete Jev decision pipeline but intentionally leaves both `event.messages` and `event.result` untouched. OpenCode should therefore perform exactly its normal native compaction.

Run:

```text
/jev-status
/compact
/jev-status
```

Expected last-run reason on a useful tool-heavy session:

```text
ok (observe-only)
```

Record:

- Jev fitted-state tokens
- Jev request count
- Jev input tokens and estimated cost
- maximum prunable percentage
- keep/truncate/drop decisions
- projected guidance size
- native compaction cache-read/cache-write/input/output tokens
- final native checkpoint size

Observe mode is the safest place to inspect whether the default `0.15` retention threshold produces sensible decisions before allowing Jev guidance to affect a summary.

## Mode 2: guided-native

Set:

```jsonc
"delivery": "guided-native"
```

Restart and run:

```text
/jev-status
/compact
/jev-status
```

Expected last-run reason:

```text
ok (native-guidance)
```

Expected request behavior:

- existing historical messages remain in the same order
- one small system guidance message is appended
- `event.result` remains unset
- OpenCode performs its native frontier-model summary request

Record the same metrics as observe mode.

The key cache hypothesis is:

> Because guided-native appends after the old transcript instead of rewriting earlier messages, the provider should be able to reuse the same historical prompt prefix that native compaction could reuse.

Do not assume this is true merely because the request shape permits it. Verify actual provider cache-read/cache-write counters.

## Mode 3: deterministic

Set:

```jsonc
"delivery": "deterministic"
```

Restart and run:

```text
/jev-status
/compact
/jev-status
```

Expected behavior:

- the plugin sets `event.result`
- the native frontier summary request is skipped
- the deterministic checkpoint is installed directly

Record:

- Jev cost and latency
- deterministic checkpoint token estimate
- next-turn input/cache behavior
- continuation quality
- unnecessary tool re-runs

## Quality checklist

For every resulting checkpoint/continuation, test whether the next model still knows:

- the current objective
- user constraints and explicit preferences
- important decisions already made
- work already completed
- active blockers or errors
- relevant files
- exact commands/identifiers needed to continue
- the next intended step

Also check whether it unnecessarily carries:

- stale read/grep/glob output
- repeated raw tool output already reflected in later reasoning
- dead-end investigation traces
- superseded diagnostics

## Cost comparison

Do not compare only the compaction call.

For each arm, consider:

```text
Jev input cost
+ compaction model uncached input
+ compaction cache read/write cost
+ compaction output
+ subsequent checkpoint input through the next compaction
+ repeated tool/reasoning work caused by lost context
```

A larger checkpoint can remain cheap while cached, but it still increases future context footprint and may become expensive when the prefix changes.

## Decision criteria

Continue with `guided-native` as the default if it:

- keeps compaction cache reuse close to native OpenCode
- materially improves the native summary's focus on consequential state
- does not increase continuation errors or unnecessary re-work
- adds little Jev latency/cost relative to downstream savings

Prefer native OpenCode and disable Jev if observe/guided-native adds cost without measurable quality improvement.

Prefer `deterministic` only if skipping the frontier summary produces a better total cost/quality result despite its typically larger retained checkpoint.

## Useful status fields

`/jev-status` should show:

- `Loaded plugin: 0.0.8`
- `Delivery: observe|guided-native|deterministic`
- compaction hook invocation count
- compaction model request count
- maximum prunable payload
- fitted Jev state size/stage
- Jev request/input token/cost metrics
- per-tool decisions
- projected/native guidance size

For `guided-native`, the compaction model request counter should advance after the hook.

For `deterministic`, a successful plugin checkpoint should prevent that native compaction model request.
