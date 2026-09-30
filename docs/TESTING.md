# Local validation and benchmark

This is the runtime validation plan for OpenCode Jev Compaction 0.1.0 on **OpenCode latest stable**.

The metric is total cost and continuation quality, not merely bytes removed at the compaction boundary.

## Preconditions

Update and validate the checkout:

```sh
cd ~/github/opencode-jev-compactor
git switch main
git pull --ff-only
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm test
```

The OpenCode process needs:

```sh
export TYPESAFE_API_KEY='...'
```

Example global plugin configuration:

```jsonc
{
  "compaction": {
    "auto": true,
    "keep": { "tokens": 15000 },
    "buffer": 30000
  },
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
        "timeoutMs": 6000,
        "historyLimit": 10
      }
    ]
  ]
}
```

Restart OpenCode after changing the plugin checkout or config.

## Pick a representative session

Use a real coding session with:

- several read/grep/glob operations
- at least one shell or mutation operation
- completed work that should not be repeated
- exact file paths, errors, commands, or identifiers worth preserving
- enough history for native compaction to be meaningful

When comparing runs, fork from the same pre-compaction boundary if possible.

## Arm 1: native OpenCode

Remove/disable the plugin and run native compaction.

Record:

- OpenCode version
- compaction model
- input tokens
- cache-read tokens
- cache-write tokens when reported
- output tokens
- latency
- resulting continuation/checkpoint size
- whether important facts survive
- unnecessary re-reads or repeated tool work on the next turn

## Arm 2: observe

Set:

```jsonc
"delivery": "observe"
```

Observe runs the full Jev decision pipeline but does not modify `output.context` or `output.prompt`. OpenCode therefore receives its normal native compaction prompt.

Run compaction and inspect OpenCode logs for service:

```text
opencode.jev-compaction
```

Record:

- Jev state size/stage
- Jev request count
- Jev input tokens and estimated cost
- maximum prunable fraction
- keep/provenance/drop decisions
- projected guidance size
- native model input/cache/output metrics

Use this arm to validate the `0.15` retention threshold before letting Jev affect the native summary.

## Arm 3: guided-native

Set:

```jsonc
"delivery": "guided-native"
```

The plugin should:

1. fetch the current session through the OpenCode SDK client
2. make one Jev decision stage
3. append one `<jev-compaction-guidance>` block through `output.context`
4. leave `output.prompt` unset
5. let OpenCode perform the normal frontier-model compaction

Record the same metrics as observe.

The cache hypothesis is:

> Appending compaction context after the serialized conversation should preserve the same historical provider prefix available to native compaction.

Verify this using actual cache-read/cache-write counters. Do not infer it only from request structure.

## Quality checklist

After each arm, ask the next model to continue the task and verify that it still knows:

- current objective
- user constraints and preferences
- important decisions
- work already completed
- active blockers/errors
- relevant files
- exact commands/identifiers needed to continue
- next intended step

Also check whether the summary unnecessarily carries:

- stale read/grep/glob output
- repeated raw tool output already reflected in later reasoning
- abandoned investigation traces
- superseded diagnostics

## Cost comparison

Compare:

```text
Jev input cost
+ compaction uncached model input
+ compaction cache read/write cost
+ compaction output
+ subsequent continuation input until the next compaction
+ repeated work caused by lost context
```

## Decision criteria

Keep `guided-native` as the default if it:

- preserves cache reuse close to native OpenCode
- improves summary focus on consequential state
- does not increase continuation errors
- adds little Jev latency/cost relative to downstream savings

Use native OpenCode alone if Jev adds cost without measurable quality improvement.

## Containment

When testing through `opencode-containment`, mount the plugin checkout read-only at the same absolute host path:

```sh
export OPENCODE_LOCAL_PLUGIN_DIRS="$HOME/github/opencode-jev-compactor"
export TYPESAFE_API_KEY='...'
```

The same `file:///home/christian/github/opencode-jev-compactor` config can then work outside and inside containment.

For an already-created Docker Sandbox, recreate it after changing the set of local plugin directories so the read-only workspace mount is present.
