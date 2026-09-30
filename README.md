# OpenCode Jev Compaction

TypeSafe Jev guidance for OpenCode's native compaction.

The plugin targets the current OpenCode plugin API rather than a pinned preview runtime. It uses the public `experimental.session.compacting` hook, fetches the current session transcript through the OpenCode client, asks Jev one set of narrow structured questions about tool evidence, and optionally appends compact guidance to OpenCode's native compaction prompt.

Jev never writes the final summary.

## Current design

```text
OpenCode compaction starts
        ↓
plugin fetches the session transcript
        ↓
deterministic eligibility + capacity preflight
        ↓
one chronological Jev state
        ↓
ONE Jev decision stage
        ↓
deterministic keep / provenance-only / stale policy
        ↓
guided-native: append compact guidance to output.context
observe:       leave output.context untouched
        ↓
OpenCode writes its normal continuation summary
```

The plugin does not rewrite historical messages. This preserves the historical request prefix that provider prompt caching may reuse.

## Delivery modes

| Mode | Jev runs | Native compaction prompt changes | Native summary runs | Use |
| --- | --- | --- | --- | --- |
| `guided-native` | yes | appends guidance only | yes | Default production candidate |
| `observe` | yes | no | yes | Validate Jev decisions without changing OpenCode behavior |
| plugin disabled | no | no | yes | Native OpenCode baseline |

The former direct checkpoint replacement mode was removed in 0.1.0 because the current public OpenCode compaction hook exposes prompt context, not a supported result-replacement API.

## Tool policy

Code decides what Jev is allowed to de-emphasize.

| Policy | Examples | Allowed outcome |
| --- | --- | --- |
| `pin_full` | question, skill, subagent, unknown tools, incomplete calls, failed results, pinned/recent calls | Full evidence remains protected |
| `protect_call` | write, edit, patch, shell/bash, execute, web fetch/search | Keep action/provenance; raw result may be summarized away |
| `drop_eligible` | read, grep, glob, find, list, ls | Keep, reduce to provenance, or mark stale |

Unknown tools fail toward full retention.

For a drop-eligible tool Jev answers two independent Noul questions:

1. Is retaining the call/input still necessary for the current objective?
2. Is retaining the exact full result still necessary?

For a protect-call tool only the exact-result question is needed because code has already protected call provenance.

The default `keepThreshold` is `0.15`. Equality keeps.

## One Jev decision stage

Jev is always one semantic decision stage.

Questions may be split across independent API requests when the request budget requires batching. An answer from one batch is never used to construct a dependent verification request.

## Cost controls

Before calling Jev, the plugin computes the maximum semantic payload that the deterministic tool policy could possibly remove or de-emphasize.

If that upper bound cannot satisfy `minReductionRatio`, the plugin falls through to native OpenCode compaction without calling Jev.

Protected-call results already at or below `truncateHeadChars` are also excluded from Jev questions because reducing them would have no useful effect.

## Safety and normalization

The plugin:

- preserves user and assistant text in its analysis projection
- parses previous structured checkpoints when present
- ignores weak follow-ups such as `continue` as standalone objectives
- excludes private reasoning/control records from retained evidence
- handles OpenCode ignored text, aborted/error assistant turns, interrupted tool output, and already-compacted results
- excludes inlined plain-text and directory pseudo-files from attachment accounting
- sanitizes host-controlled tool IDs/names before they enter Jev instructions or native guidance
- redacts common secret patterns before TypeSafe requests
- requires HTTPS for TypeSafe except loopback HTTP during local testing
- rejects TypeSafe URL credentials, fragments, and redirects
- fails open to ordinary OpenCode compaction on errors or malformed Jev responses

## Install from a checkout

No npm publication or OpenCode version pin is required.

```sh
cd ~/github/opencode-jev-compactor
git switch main
git pull --ff-only
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm test
```

Set the TypeSafe key in the environment that launches OpenCode:

```sh
export TYPESAFE_API_KEY='...'
```

Then add the plugin to OpenCode config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "compaction": {
    "auto": true,
    "prune": false
  },
  "plugin": [
    [
      "file:///home/christian/github/opencode-jev-compactor/src/index.ts",
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

For the first test use `observe`. After validating Jev decisions, switch to:

```jsonc
"delivery": "guided-native"
```

## Global vs project config

OpenCode can load the same plugin from either global or project configuration.

Use the global config when you want the plugin available across normal OpenCode sessions:

```text
~/.config/opencode/opencode.jsonc
```

Use a project config when you only want it in one repository:

```text
./opencode.jsonc
./opencode.json
```

The plugin URL is resolved by the OpenCode process, so containerized OpenCode must be able to see the checkout at that same absolute path.

## opencode-containment

`christian-taillon/opencode-containment` now supports this checkout directly while continuing to use `ghcr.io/anomalyco/opencode:latest`.

The containment launchers:

- mount `$HOME/github/opencode-jev-compactor` read-only at the same absolute path when it exists
- pass `TYPESAFE_API_KEY` when it is set
- make the same trusted checkout available to the Docker Sandboxes backend
- allow `api.typesafe.ai:443` in the project sandbox network policy

Override or disable the automatic checkout mount with:

```sh
export OPENCODE_JEV_PLUGIN_DIR=/alternate/path
# or
export OPENCODE_JEV_PLUGIN_DIR=
```

## Runtime diagnostics

OpenCode's current public plugin API does not expose the old custom RPC/TUI surface used by the preview adapter.

The plugin therefore writes structured logs and persists bounded run history at:

```text
$XDG_STATE_HOME/opencode/jev-compaction/state.json
```

or, when `XDG_STATE_HOME` is unset:

```text
~/.local/state/opencode/jev-compaction/state.json
```

Each run records Jev request/input token cost, fitted-state size, maximum prunable payload, tool decisions, projected guidance size, and fallback reason.

## Local validation

See [docs/TESTING.md](docs/TESTING.md).

The intended comparison is:

1. native OpenCode with the plugin disabled
2. `observe`
3. `guided-native`

Measure provider cache reads/writes, compaction input/output, Jev cost, summary size, and continuation quality.

## Development

```sh
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm test
```

CI runs the same install, typecheck, and test path with the lockfile frozen.

## References

- https://docs.typesafe.ai/introduction
- https://docs.typesafe.ai/concepts/how-to-build-with-system-one
- https://docs.typesafe.ai/concepts/state
- https://docs.typesafe.ai/primitives/noul
- https://docs.typesafe.ai/api
- https://opencode.ai/docs/plugins/
