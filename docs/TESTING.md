# Local validation

Use one representative long coding session and compare three compaction paths:

1. native OpenCode
2. Jev `observe`
3. Jev `guided-native`

The useful metric is total cost and continuation quality through the next compaction, not only bytes removed at the current compaction boundary.

## Preconditions

```sh
cd ~/github/opencode-jev-compactor
git switch main
git pull --ff-only
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm run build
corepack pnpm test
```

Set:

```sh
export TYPESAFE_API_KEY='...'
```

Use the checkout directly in OpenCode config:

```jsonc
"plugin": [
  [
    "file:///home/christian/github/opencode-jev-compactor/dist/index.js",
    {
      "enabled": true,
      "delivery": "observe",
      "keepThreshold": 0.15,
      "preserveRecentMessages": 6,
      "minReductionRatio": 0.15
    }
  ]
]
```

Restart the OpenCode process after changing plugin configuration.

## Representative session

Prefer a real session containing several read/grep/glob operations, at least one shell or mutation operation, completed work that should not be repeated, exact identifiers or commands worth preserving, and enough context for native compaction to be meaningful.

Use equivalent forks/session boundaries for each arm.

## 1. Native baseline

Disable the plugin in config:

```jsonc
"enabled": false
```

Run the normal OpenCode compaction command.

Record:

- compaction model
- input tokens
- cache-read tokens
- cache-write tokens when reported
- output tokens
- latency
- resulting continuation summary size
- whether the next response preserves important facts
- unnecessary tool re-runs or re-reading

## 2. Observe

Set:

```jsonc
"enabled": true,
"delivery": "observe"
```

Observe runs the complete Jev decision pipeline but does not add anything to OpenCode's compaction prompt.

After compaction inspect:

```sh
cat "${XDG_STATE_HOME:-$HOME/.local/state}/opencode/jev-compaction/state.json"
```

Record:

- Jev fitted-state tokens
- Jev request count
- Jev input tokens and estimated cost
- maximum prunable percentage
- tool keep/provenance/stale decisions
- projected guidance size
- native compaction provider cache/input/output metrics

Use this mode to validate the `0.15` threshold before allowing guidance to affect the summary.

## 3. Guided native

Set:

```jsonc
"delivery": "guided-native"
```

Run compaction from an equivalent session boundary.

Expected behavior:

- plugin fetches the current session transcript
- Jev runs once
- existing historical messages are not rewritten
- guidance is appended through OpenCode's `experimental.session.compacting` context array
- OpenCode writes its native continuation summary

Record the same provider and Jev metrics.

The cache hypothesis is that adding compaction context leaves the historical prompt prefix unchanged, allowing the provider to reuse the same cache prefix available to native compaction. Verify actual provider counters rather than assuming this.

## Quality checklist

After each compaction, verify the continuation retains:

- current objective
- explicit user constraints/preferences
- important decisions
- completed work
- active blockers/errors
- relevant files
- exact commands/identifiers needed to continue
- next intended step

Also check whether it unnecessarily carries stale read/grep/glob output, repeated raw tool output already reflected in later reasoning, dead-end investigations, or superseded diagnostics.

## Cost comparison

Compare:

```text
Jev input cost
+ compaction uncached input
+ compaction cache read/write cost
+ compaction output
+ subsequent summary input until the next compaction
+ repeated work caused by lost context
```

Keep `guided-native` as the default only if it improves focus/continuation quality without materially degrading cache reuse or total cost.
