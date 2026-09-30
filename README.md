# OpenCode Jev Compaction

TypeSafe Jev guidance for OpenCode's native compaction.

The plugin keeps application code in control. Jev makes narrow probabilistic judgments about tool evidence; OpenCode's own compaction model still writes the continuation summary.

## Current architecture

Version `0.1.0` targets the current stable OpenCode plugin surface and intentionally does **not** pin an OpenCode runtime version.

OpenCode provides the `experimental.session.compacting` hook before it generates the native continuation summary. The plugin:

1. Reads the current session transcript with `client.session.messages`.
2. Resolves the active objective and builds one chronological Jev state.
3. Runs one Jev decision stage.
4. Applies deterministic tool-safety policy.
5. In `guided-native`, appends compact guidance through `output.context`.
6. Lets OpenCode generate its normal final summary.

```text
OpenCode native compaction
        ↓
experimental.session.compacting
        ↓
read current session transcript
        ↓
deterministic pruning-capacity preflight
        ↓
ONE Jev decision stage
        ↓
deterministic tool policy
        ↓
output.context.push(guidance)
        ↓
OpenCode native continuation summary
```

There is no second Jev verification pass.

## Delivery modes

| Mode | Behavior |
| --- | --- |
| `guided-native` | Default. Run Jev and add compact guidance to OpenCode's native compaction prompt. |
| `observe` | Run the same Jev analysis but do not change OpenCode's compaction prompt. |
| plugin disabled | Pure native OpenCode baseline. |

The old `deterministic` delivery mode belonged to the retired OpenCode 2 preview adapter. Current stable OpenCode exposes compaction prompt/context customization rather than replacement of the completed compaction result, so `deterministic` is no longer an active mode.

## Tool policy

Application code decides what Jev is allowed to de-emphasize.

| Policy | Examples | Allowed behavior |
| --- | --- | --- |
| `pin_full` | `question`, `skill`, `subagent`, unknown tools, incomplete calls, failed results, pinned/recent calls | Full evidence remains protected. |
| `protect_call` | `write`, `edit`, `patch`, `shell`, `execute`, web fetch/search | Preserve action/provenance; raw result may be summarized away. |
| `drop_eligible` | `read`, `grep`, `glob`, `find`, `list`, `ls` | Keep full evidence, retain provenance only, or treat stale repeatable evidence as omittable. |

Unknown tools fail toward full retention.

For `drop_eligible` tools Jev answers two independent Noul questions:

1. Is retaining the call/input still necessary for the current objective?
2. Is retaining the exact full result still necessary?

For `protect_call` tools only the exact-result question is needed because code already protects provenance.

The default `keepThreshold` is `0.15`. Equality keeps.

## Cost controls

Before Jev runs, the plugin computes the maximum semantic payload the deterministic policy could possibly de-emphasize.

If even the best possible result cannot reach `minReductionRatio`, the plugin falls through to native compaction with `insufficient-prunable-payload` and spends zero Jev tokens.

Short protected-call results are omitted from Jev questions when reducing them would be a no-op.

## Safety

The plugin:

- preserves user/assistant text for Jev analysis
- protects unknown, failed, incomplete, recent, and pinned tool evidence
- handles interrupted and already-compacted OpenCode tool results
- excludes ignored user text and dropped errored assistant turns where OpenCode marks them
- removes reasoning/control records from the Jev checkpoint state
- best-effort redacts secrets before TypeSafe requests
- sanitizes host-controlled tool IDs/names before Jev state/questions/guidance
- requires HTTPS for TypeSafe except loopback HTTP in local tests
- rejects URL credentials/fragments and HTTP redirects
- fails open to native OpenCode compaction on malformed responses, timeouts, state-fit failures, or internal errors

## Install from a checkout

```sh
cd ~/github/opencode-jev-compactor
git switch main
git pull --ff-only
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm test
```

No npm publication or OpenCode SDK package installation is required at runtime.

### OpenCode config

Current OpenCode uses the singular `plugin` config key. A local checkout can be loaded with a `file://` URL and tuple options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
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

Start with `observe`, inspect behavior and provider usage, then switch to `guided-native`.

The OpenCode process must receive:

```sh
export TYPESAFE_API_KEY='...'
```

### Global vs project scope

OpenCode merges plugin declarations from global and project configuration.

- Global config: `~/.config/opencode/opencode.json` or `opencode.jsonc`
- Project config: `opencode.json` / `opencode.jsonc` in the project

Use global config when testing the plugin across repositories. Use project config for a narrow rollout.

Avoid loading the same checkout both through config and a plugin directory, because both plugin instances can run.

## Options

| Option | Default | Purpose |
| --- | ---: | --- |
| `enabled` | `true` | Enable Jev analysis during native compaction. |
| `delivery` | `guided-native` | `guided-native` or `observe`. |
| `model` | `jev-latest` | TypeSafe System One model alias. |
| `keepThreshold` | `0.15` | Retention probability threshold. Equality keeps. |
| `preserveRecentMessages` | `6` | Protect newest messages from tool pruning judgments. |
| `minReductionRatio` | `0.15` | Minimum semantic payload worth targeting. |
| `toolResultPreviewChars` | `300` | Exact result prefix included in Jev state. |
| `truncateHeadChars` | `600` | Protected-result usefulness threshold. |
| `maxStateChars` | `100000` | Jev-state character ceiling. |
| `maxStateTokens` | `24000` | Jev-state estimated-token ceiling. |
| `maxRequestTokens` | `30000` | State + question request budget. |
| `maxConcurrentRequests` | `2` | Concurrent independent Jev batches. |
| `timeoutMs` | `6000` | Total Jev decision window. |
| `historyLimit` | `10` | In-memory run-history bound for structured diagnostics. |
| `jevInputCostPerMillionUsd` | `0.042` | Display-only Jev input-cost estimate. |
| `baseUrl` | TypeSafe System One API | HTTPS endpoint; loopback HTTP allowed for testing. |

## Diagnostics

The old OpenCode 2 preview TUI/RPC commands (`/jev-status`, `/jev-toggle`, `/jev-reset`) were removed with that adapter.

Current stable integration emits structured logs with:

```text
plugin = opencode.jev-compaction
```

A successful guided run records `native-guidance`; observe mode records `observe-only`. The log payload includes the formatted Jev run summary and tool decision diagnostics.

See [docs/TESTING.md](docs/TESTING.md) for the local benchmark procedure.

## Development

```sh
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm test
```

CI runs frozen install, typecheck, and tests.

## References

- https://docs.typesafe.ai/introduction
- https://docs.typesafe.ai/concepts/how-to-build-with-system-one
- https://docs.typesafe.ai/concepts/state
- https://docs.typesafe.ai/primitives/noul
- https://docs.typesafe.ai/api
- https://opencode.ai/docs/plugins
