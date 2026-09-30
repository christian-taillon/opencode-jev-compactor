# OpenCode Jev Compaction

TypeSafe Jev guidance for the current stable OpenCode compaction pipeline.

The plugin keeps application code in control and uses Jev only for narrow judgments about historical tool evidence. Jev never writes the final summary. By default, Jev identifies stale or provenance-only tool traces, the plugin appends compact guidance through OpenCode's native compaction hook, and OpenCode's own frontier model writes the continuation summary.

## Compatibility

Version `0.1.0` follows **OpenCode latest stable** rather than pinning an OpenCode SDK version.

It uses OpenCode's current public plugin contract:

```ts
"experimental.session.compacting": async (input, output) => {
  output.context.push(guidance)
}
```

The repository has no runtime dependency on `@opencode/plugin`. This avoids coupling the plugin checkout to a particular OpenCode package release.

The compaction hook is still named `experimental.session.compacting` upstream, so compatibility with a newly released `opencode:latest` should always be covered by smoke testing.

## Architecture

```text
OpenCode native compaction
        ↓
experimental.session.compacting
        ↓
fetch current session transcript through OpenCode SDK client
        ↓
normalize transcript
        ↓
resolve current objective
        ↓
deterministic pruning-capacity preflight
        ↓
fit one chronological Jev state
        ↓
ONE Jev decision stage
        ↓
deterministic keep / provenance-only / stale policy
        ↓
append small guidance to output.context
        ↓
OpenCode native compaction model writes final summary
```

Jev is always one decision stage. Independent questions may be split into multiple request-budget batches, but a Jev answer never triggers a second verification request.

### Delivery modes

| Mode | Jev runs | Changes native transcript | Changes compaction prompt | Native summary runs |
| --- | --- | --- | --- | --- |
| `guided-native` | yes | no | appends guidance only | yes |
| `observe` | yes | no | no | yes |
| plugin disabled | no | no | no | yes |

The former `deterministic` mode is not part of the current stable integration. OpenCode latest exposes compaction prompt/context customization through the public plugin hook, but not a supported plugin mechanism to install a replacement summary result and skip the native model request.

## Why guided-native

The native summary is useful. It can compress conversational prose and completed work much more effectively than preserving all user/assistant text verbatim.

Jev's role is therefore narrower:

- identify repeatable tool evidence that does not need to survive the checkpoint
- distinguish raw result detail from important action provenance
- keep uncertain, failed, incomplete, recent, or unknown tool evidence protected
- give the native summarizer a small, typed decision signal

OpenCode serializes the existing conversation before applying `output.context`. Appending guidance therefore avoids rewriting the historical conversation prefix immediately before the compaction model call. That is the cache-friendly property we want to validate with real provider usage counters.

## Deterministic tool policy

Application code determines what Jev is allowed to classify as stale.

| Policy | Examples | Allowed recommendation |
| --- | --- | --- |
| `pin_full` | `question`, `skill`, `subagent`, unknown tools, incomplete calls, failed results, pinned/recent calls | no destructive recommendation |
| `protect_call` | `write`, `edit`, `patch`, `shell`, `execute`, web fetch/search | preserve action/provenance; raw result may be de-emphasized |
| `drop_eligible` | `read`, `grep`, `glob`, `find`, `list`, `ls` | full keep, provenance-only, or stale/omit |

Unknown tools fail toward full retention.

For `drop_eligible` tools Jev answers two independent Nouls:

1. Is retaining the call/input still necessary for the current objective?
2. Is retaining the exact full result still necessary?

For `protect_call` tools only the exact-result question is needed because code has already protected provenance.

The default `keepThreshold` is `0.15`. Equality keeps.

## Cost controls

Before calling Jev, the plugin computes the maximum semantic payload the active policy could possibly de-emphasize.

If even the best possible outcome cannot satisfy `minReductionRatio`, the plugin returns without calling Jev and native OpenCode compaction proceeds unchanged.

Protected-call results already at or below `truncateHeadChars` are also excluded from Jev questions because reducing them would have no meaningful effect.

## Safety and compatibility behavior

The plugin:

- reads the current session through OpenCode's SDK client only when compaction runs
- normalizes current `{ info, parts }` message shapes
- handles current `ToolPart.callID`, `ToolPart.tool`, and tool-state output shapes
- ignores user text OpenCode marks ignored
- excludes dropped errored assistant turns
- preserves meaningful aborted turns
- recognizes interrupted tool output
- does not treat already-compacted tool output as live bulky evidence
- ignores inlined plain-text and directory pseudo-file attachments
- sanitizes host-controlled IDs/names before Jev state, Jev questions, or guidance
- redacts common secret shapes before sending the fitted state to TypeSafe
- defaults unknown/incomplete/failed tools toward retention
- fails open when session retrieval, Jev, parsing, or state fitting fails
- requires HTTPS for TypeSafe except loopback HTTP used for local testing
- rejects TypeSafe URL credentials, fragments, and HTTP redirects

A failure never blocks native OpenCode compaction.

## Install from a checkout

For normal runtime use, the plugin does not need to be globally installed or published to npm.

Clone/update it:

```sh
cd ~/github/opencode-jev-compactor
git switch main
git pull --ff-only
```

For development validation:

```sh
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm test
```

OpenCode can load the repository directly through a `file://` plugin spec.

## Configuration

### Global

Linux/macOS:

```text
~/.config/opencode/opencode.jsonc
```

or `opencode.json`.

### Project

Use `opencode.jsonc` or `opencode.json` in the project root when the plugin should apply only to that project.

### Recommended first test

Start in `observe`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",

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

The OpenCode process also needs:

```sh
export TYPESAFE_API_KEY='...'
```

After validating the decisions in logs, switch to:

```jsonc
"delivery": "guided-native"
```

## Containment

`opencode-containment` supports mounting local plugin checkouts read-only at the same absolute path inside the runtime.

Recommended host settings:

```sh
export OPENCODE_LOCAL_PLUGIN_DIRS="$HOME/github/opencode-jev-compactor"
export TYPESAFE_API_KEY='...'
```

Then the same global plugin spec can work both on the host and inside containment:

```jsonc
"plugin": [
  [
    "file:///home/christian/github/opencode-jev-compactor",
    { "enabled": true, "delivery": "observe" }
  ]
]
```

See the containment repository documentation for container and sandbox details.

## Options

| Option | Default | Purpose |
| --- | ---: | --- |
| `enabled` | `true` | Enable Jev decisions |
| `delivery` | `guided-native` | `guided-native` or `observe` |
| `model` | `jev-latest` | TypeSafe System One model |
| `keepThreshold` | `0.15` | Retention threshold; equality keeps |
| `preserveRecentMessages` | `6` | Pin the newest N messages |
| `minReductionRatio` | `0.15` | Minimum semantic payload fraction worth targeting |
| `toolResultPreviewChars` | `300` | Exact result prefix included in Jev state |
| `truncateHeadChars` | `600` | Result-detail usefulness threshold |
| `maxStateChars` | `100000` | Jev-state character ceiling |
| `maxStateTokens` | `24000` | Jev-state estimated-token ceiling |
| `maxRequestTokens` | `30000` | State + question budget |
| `maxConcurrentRequests` | `2` | Concurrent independent Jev batches |
| `timeoutMs` | `6000` | Total Jev decision window |
| `historyLimit` | `10` | Bounded in-memory diagnostic history |
| `jevInputCostPerMillionUsd` | `0.042` | Display-only Jev input-cost estimate |
| `baseUrl` | TypeSafe System One | HTTPS endpoint; loopback HTTP allowed |

## Diagnostics

OpenCode latest no longer uses the old experimental v2 server-plugin RPC/TUI surface that powered `/jev-status`.

Current diagnostics are emitted through `client.app.log()` under:

```text
opencode.jev-compaction
```

Each useful run includes a formatted decision summary with Jev state size, input tokens/cost, maximum prunable payload, and bounded per-tool decisions. No raw tool payload is written to the guidance.

See [docs/TESTING.md](docs/TESTING.md) for the local comparison procedure.

## Development

```sh
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm test
```

CI uses the frozen lockfile.

## References

- https://docs.typesafe.ai/introduction
- https://docs.typesafe.ai/concepts/how-to-build-with-system-one
- https://docs.typesafe.ai/concepts/state
- https://docs.typesafe.ai/primitives/noul
- https://docs.typesafe.ai/api
- https://opencode.ai/docs/plugins/
