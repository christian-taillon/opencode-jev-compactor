# OpenCode Jev Compaction

TypeSafe Jev guidance for OpenCode v2 compaction.

The plugin keeps **code in control** and uses Jev only for narrow semantic judgments about tool evidence. Jev never writes the final summary. The default mode preserves the existing compaction request prefix, appends a small guidance message, and lets OpenCode's native frontier model produce the final structured checkpoint.

## Status

Version `0.0.8` targets **OpenCode 2.0.14** and pins `@opencode/plugin` to exactly `2.0.14`.

The default architecture is ready for local validation, but provider prompt-cache behavior and continuation quality still need to be measured on real sessions.

## Architecture

### Default: guided-native

```text
OpenCode session.compaction
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
append compact guidance after the unchanged transcript
        ↓
OpenCode native summary prompt
        ↓
frontier model writes the final checkpoint
```

The existing historical messages are not rewritten before OpenCode's compaction model request. This preserves the request prefix so providers that support prefix caching can continue matching it.

### Delivery modes

| Mode | Jev runs | Changes native compaction input | Frontier summary runs | Purpose |
| --- | --- | --- | --- | --- |
| `guided-native` | yes | appends guidance only | yes | Default production candidate |
| `observe` | yes | no | yes | Measure Jev decisions/cost without affecting OpenCode behavior |
| `deterministic` | yes | replaces final result through `event.result` | no | Compare against the no-frontier-summary design |
| plugin disabled | no | no | yes | Native OpenCode baseline |

Jev is always **one decision stage**. Request-budget batching may split independent questions across API requests, but an answer never triggers a second verification judgment.

## Tool policy

Application code determines what Jev is allowed to de-emphasize.

| Policy | Examples | Allowed behavior |
| --- | --- | --- |
| `pin_full` | `question`, `skill`, `subagent`, unknown tools, incomplete calls, failed results, pinned/recent calls | Full evidence remains protected |
| `protect_call` | `write`, `edit`, `patch`, `shell`, `execute`, web fetch/search | Action/provenance stays; raw result may be summarized away |
| `drop_eligible` | `read`, `grep`, `glob`, `find`, `list`, `ls` | Full keep, provenance-only, or stale/omit |

Unknown tools fail toward full retention.

For `drop_eligible` tools Jev answers two independent Nouls:

1. Is the call/input still necessary for the current objective?
2. Is the exact full result still necessary?

For `protect_call` tools only the exact-result question is needed because code already decided the call provenance stays.

The default `keepThreshold` is `0.15`. Equality keeps, so destructive recommendations require a probability below the threshold.

## Cache-friendly guidance

A successful `guided-native` run appends one chronological system message after the existing transcript:

```text
<existing cached transcript>
<jev-compaction-guidance>
  omit stale repeatable calls A/B
  preserve only consequential provenance for C/D
</jev-compaction-guidance>
<OpenCode native summary prompt>
```

The plugin does not modify `event.system` and does not rewrite earlier `event.messages`.

Guidance contains only sanitized tool IDs/names and coarse actions. Raw tool inputs, outputs, and Jev probabilities are not copied into the guidance.

This is designed to preserve provider prefix-cache reuse. Actual cache behavior is provider-specific and must be measured.

## Cost controls

Before Jev is called, the plugin computes the maximum semantic payload the active tool policy could possibly remove or de-emphasize.

If even the best possible outcome cannot satisfy `minReductionRatio`, the plugin falls through to native OpenCode compaction with:

```text
insufficient-prunable-payload
```

and spends zero Jev tokens.

Protected-call results already at or below `truncateHeadChars` are also omitted from Jev questions because reducing them would have no meaningful effect.

## State and safety

Jev receives an ordered state containing:

- resolved current objective
- previous structured checkpoint baseline, when present
- user/assistant conversation text
- tool inputs
- result status and size
- a small exact result preview

The local transcript is not modified while the Jev state is fitted.

Additional safeguards include:

- best-effort secret redaction before TypeSafe requests
- host-controlled tool IDs/names sanitized before entering Jev instructions/state
- unknown tools retained by default
- incomplete and failed tool calls retained by default
- interrupted tool output handled explicitly
- results already cleared by OpenCode are not treated as live bulky output
- ignored user text and dropped errored assistant turns are excluded when those host shapes are encountered
- inlined plain-text pseudo-files and directory pseudo-files are excluded from attachment accounting
- malformed/missing Jev answers fail open to native OpenCode compaction
- TypeSafe API URLs must use HTTPS, except loopback HTTP for local testing
- redirects are rejected on TypeSafe requests so the bearer token cannot be silently redirected

## Previous checkpoints and weak follow-ups

Previous `<conversation-checkpoint>` content is parsed into structured baseline sections. Material before that checkpoint is not re-scored or copied back as a raw envelope.

Weak follow-ups such as `more`, `continue`, and `more more` are not treated as standalone objectives. Resolution order is:

1. newest substantive user request
2. previous checkpoint objective
3. newest earlier substantive user request
4. otherwise native fallback via `weak-objective-unresolved`

## Install from a checkout

No npm publication step is required for local testing.

```sh
cd /home/christian/github/opencode-jev-compactor
git switch main
git pull
corepack pnpm install
corepack pnpm run typecheck
corepack pnpm test
```

Then configure OpenCode to load the checkout directly.

### Global vs project scope

For OpenCode 2.0.14:

- **Global config:** `~/.config/opencode/opencode.jsonc` or `~/.config/opencode/opencode.json`
- **Project config:** `./opencode.jsonc`, `./opencode.json`, or `.opencode/opencode.json`

Use **global config** when testing the plugin across normal OpenCode sessions and repositories.

Use **project config** when you want Jev compaction enabled only for one repository.

Do not also copy the same plugin into `~/.config/opencode/plugins/` or `.opencode/plugins/` when loading it by package path. OpenCode loads plugins from all configured sources, so duplicate local copies can register duplicate hooks.

### Recommended global test config

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

For the first local run, `observe` is recommended because it collects Jev decisions without changing native OpenCode compaction. After validating the decisions, switch to `guided-native`.

The OpenCode server process must have:

```sh
export TYPESAFE_API_KEY='your-key-here'
```

Restart the OpenCode server/service after changing the checkout or plugin configuration.

## Options

| Option | Default | Purpose |
| --- | ---: | --- |
| `enabled` | `true` | Configured default for Jev interception |
| `delivery` | `guided-native` | `guided-native`, `observe`, or `deterministic` |
| `model` | `jev-latest` | TypeSafe System One model alias |
| `keepThreshold` | `0.15` | Retention probability threshold; equality keeps |
| `preserveRecentMessages` | `6` | Pins the newest N messages; first message and newest user request are also pinned |
| `minReductionRatio` | `0.15` | Minimum semantic payload fraction worth targeting |
| `toolResultPreviewChars` | `300` | Exact result prefix included in Jev state |
| `truncateHeadChars` | `600` | Retained prefix in deterministic mode and protected-result usefulness threshold |
| `maxStateChars` | `100000` | Jev-state character ceiling |
| `maxStateTokens` | `24000` | Jev-state estimated-token ceiling |
| `maxRequestTokens` | `30000` | State + question request budget |
| `maxConcurrentRequests` | `2` | Concurrent independent Jev batches |
| `timeoutMs` | `6000` | Total Jev decision window |
| `enableCompareTool` | `true` | Registers the optional `jev_compare` tool |
| `historyLimit` | `10` | Stored run records |
| `jevInputCostPerMillionUsd` | `0.042` | Display-only Jev input cost estimate |
| `baseUrl` | TypeSafe System One API | HTTPS endpoint; loopback HTTP allowed for local testing |

The old `verificationThreshold`, `verificationResultPreviewChars`, and `uncertaintyMargin` options are obsolete and ignored.

## TUI diagnostics

```text
/jev-status
/jev-toggle
/jev-reset
```

`/jev-status` reports:

- plugin version and delivery mode
- process/instance and OpenCode Location
- compaction hook/request counters
- fitted Jev state size/stage
- maximum prunable payload
- Jev request count/input tokens/latency/cost
- per-tool keep/provenance/drop decisions
- projected/native guidance size
- projected deterministic checkpoint size

Historical 0.0.5 verification probabilities remain readable, but current runs never issue a verification pass.

## Local validation

See [docs/TESTING.md](docs/TESTING.md) for the full benchmark procedure.

The intended comparison is:

1. native OpenCode
2. Jev `observe`
3. Jev `guided-native`
4. Jev `deterministic`

The useful metric is **total cost and continuation quality until the next compaction**, not just bytes removed at the current boundary.

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
- https://opencode.ai/v2/docs/compaction/
- https://opencode.ai/v2/docs/build/plugins/
