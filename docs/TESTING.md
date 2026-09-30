# Local validation

Validate three paths on the same representative long OpenCode session:

1. native OpenCode with the Jev plugin disabled
2. Jev `observe`
3. Jev `guided-native`

The goal is total cost and continuation quality, not maximum bytes removed.

## Prepare

```sh
cd ~/github/opencode-jev-compactor
git switch main
git pull --ff-only
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm test
```

Export the TypeSafe key into the process that launches OpenCode:

```sh
export TYPESAFE_API_KEY='...'
```

Configure the local plugin checkout with current OpenCode's singular `plugin` key:

```jsonc
{
  "plugin": [
    [
      "file:///home/christian/github/opencode-jev-compactor",
      {
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
        "timeoutMs": 6000
      }
    ]
  ]
}
```

Restart OpenCode after changing plugin code or configuration.

## Representative session

Use a long coding session with several read/grep/glob calls, at least one shell or mutation action, completed work, exact file paths/errors/commands worth retaining, and enough context for native compaction to matter.

For comparative tests, start each arm from the same pre-compaction session boundary.

## Native baseline

Set `enabled: false` or remove the plugin, then run native `/compact`.

Record:

- compaction model
- input tokens
- cache-read/cache-write tokens when exposed by the provider
- output tokens
- latency
- resulting continuation-summary size
- whether important objective/constraints/files/errors survive
- unnecessary re-reading or tool re-runs afterward

## Observe

Set:

```jsonc
"delivery": "observe"
```

Observe executes the full Jev analysis but does not modify `output.context` or replace the native compaction prompt.

Run `/compact` and inspect structured OpenCode logs for `opencode.jev-compaction`.

A useful run should record `observe-only`. Capture:

- fitted Jev-state tokens
- Jev request count/input tokens/estimated cost
- maximum prunable percentage
- keep/provenance/drop recommendations
- projected guidance size
- native compaction provider usage
- final native summary quality

Use this mode first to verify the `0.15` threshold on real sessions.

## Guided native

Set:

```jsonc
"delivery": "guided-native"
```

On `/compact`, Jev guidance is appended through OpenCode's documented `experimental.session.compacting` `output.context` surface. OpenCode then generates its normal continuation summary.

A useful run should record `native-guidance`.

Record the same provider and quality metrics as observe.

Do not assume prompt-cache behavior. Current stable OpenCode constructs a dedicated native compaction request, so cache reuse is provider/runtime dependent and should be measured from actual usage counters.

## Quality checklist

After each compaction, verify that the continuation still knows:

- current objective
- explicit user constraints
- decisions already made
- completed work
- unresolved blockers/errors
- relevant files
- exact commands/identifiers needed next
- next intended action

Also note stale read/grep/glob output, dead-end traces, or superseded diagnostics that survive unnecessarily.

## Cost comparison

Compare:

```text
Jev input cost
+ native compaction model cost
+ provider cache read/write effects
+ subsequent summary/context cost until next compaction
+ repeated reasoning/tool work caused by lost context
```

Keep `guided-native` only if it measurably improves continuation quality or downstream context efficiency enough to justify Jev cost/latency. Otherwise prefer native OpenCode.
