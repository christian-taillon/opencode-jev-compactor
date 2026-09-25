# Changelog

## Unreleased

## 0.0.7

Maturity and cost-control improvements for the single-pass design.

- Added a deterministic pruning-capacity preflight before Jev. If the maximum possible policy-approved reduction cannot reach `minReductionRatio`, the plugin falls through to native OpenCode compaction without spending a Jev request.
- Skip Jev questions for protected-call results that are already at or below `truncateHeadChars`, because truncation would be a no-op.
- Added maximum-prunable payload, percentage, and eligible-tool diagnostics to run history.
- Added GitHub Actions CI for install, typecheck, and tests.
- Fixed the displayed Jev cost prefix in detailed run diagnostics.
- Kept the one-pass rule unchanged: request-budget batching may create multiple independent API requests, but no Jev answer triggers a dependent second judgment.

## 0.0.6

Single-pass Jev compaction with deterministic safety policy.

- Removed the destructive-action verification round. A compaction run now evaluates each eligible tool only once; request-budget batching may create multiple API requests, but there is no dependent second Jev pass.
- Moved destructive eligibility into deterministic code. Unknown, incomplete, pinned, and failed tools keep full evidence; mutation/remote-action tools keep call provenance; only an explicit allowlist of cheap read-only tools may be dropped completely.
- Lowered the default retention threshold to 0.15, matching the observed probability distribution for old tool calls while keeping equality conservative.
- Removed `verificationThreshold`, `verificationResultPreviewChars`, and `uncertaintyMargin` from the active configuration surface.
- Added bounded first-pass batch concurrency with `maxConcurrentRequests` (default 2).
- Preserved verbatim user/assistant text, chronological state fitting, previous-checkpoint baselines, semantic-reduction acceptance, native OpenCode fallback, redaction, and existing run diagnostics.
- Kept legacy verification fields readable in historical 0.0.5 run records.


- Pinned `@opencode/plugin` to OpenCode 2.0.14 and verified the compaction hook, RPC, TUI, and storage contracts.
- Displayed the loaded plugin version and per-load hook invocation count/timestamp separately from historical compaction runs in `/jev-status`.
- Added conventional root entrypoints so OpenCode 2.0.7 can discover all server, TUI, and RPC features when the repository is configured as a local plugin directory.
- Mounted TUI keymap registration inside the application slot to ensure the OpenCode keymap provider exists during registration.
- Made `/jev-status` easier to read with an extra-large dialog, one detailed latest run, and compact previous-run summaries.
- Documented the 0.0.3 `state-cannot-fit` fallback for transcripts that exceed the single fitted Jev-state ceiling.

## 0.0.5

Simplified Jev compaction architecture informed by practical tool-pruning patterns.

- Replaced separate Jev text/tool/file/constraint scoring surfaces with a chronological conversation projection.
- Reduced the normal tool decision pass from roughly ten judgments per tool to two independent Noul questions: keep call provenance and keep full result.
- Added a second destructive-action verification pass for every proposed truncate/drop, using richer candidate evidence and a high verification threshold.
- Changed the default policy to preserve all user and assistant text verbatim; Jev now focuses on high-volume tool traces.
- Reduced first-pass tool-result previews from 8,000 characters to 300 characters by default while retaining up to 8,000 characters only for targeted verification.
- Added aggressive Jev-only state fitting: staged input truncation, old-text abridgement/collapse, compact one-line tool traces, removal of old call-less state entries, and merging of adjacent call-only entries.
- Tightened the shared request budget to 30,000 estimated tokens and state budget to 24,000.
- Replaced serialized JSON-to-Markdown reduction as the acceptance metric with semantic payload reduction over conversational text, tool inputs, tool results, and attachment descriptors.
- Kept serialized reduction as diagnostics only.
- Added per-tool decision diagnostics including keep-call, keep-result, verification probability, and final action.
- Added session ID and plugin version to compaction run metrics.
- Record `preexisting-compaction-result` when another plugin instance or compaction handler has already populated `event.result`, instead of silently returning.
- Updated the regression suite for ordered state, two-pass verification, text preservation, semantic payload accounting, and richer observability.
- Candidate-state chunking remains out of scope until the stronger fitting pipeline is validated on real long sessions.

## 0.0.4

False-positive compaction quality correction.

- Added a semantic-reduction acceptance gate. Serialized Markdown shrink alone can no longer count as successful compaction; Jev must drop an eligible text block, drop a tool item, or actually truncate a tool result.
- Added `no-semantic-reduction` fallback so OpenCode native compaction handles keep-everything Jev runs.
- Excluded reasoning parts, system/control records, raw `<conversation-checkpoint>` envelopes, and empty placeholder sections from generated checkpoints.
- Added deterministic weak-follow-up objective resolution: newest substantive user request, previous checkpoint objective, then newest earlier substantive request; otherwise fall back with `weak-objective-unresolved`.
- Added structured previous-checkpoint parsing. Earlier checkpoint sections become baseline state, only newer transcript material is evaluated, and the prior envelope is not embedded verbatim as evidence.
- Added `semanticReductionActions` observability separately from estimated serialized-size reduction.
- Added a focused regression fixture reproducing the false-positive run with zero tools, weak `more` / `continue` prompts, reasoning/control records, and a keep-everything Jev response.
- Kept OpenCode recent-tail behavior separate; this release does not change the recommended `compaction.keep.tokens` value.
- Kept long-session candidate-state chunking out of scope for this quality correction.

## 0.0.3

OpenCode 2.0.7 compatibility hotfix.

- Pinned `@opencode/plugin` to `2.0.7` for this compatibility release.
- Updated RPC definitions to the 2.0.7 portable contract: every method has explicit input/output schemas and the definition has an `events` map.
- Updated TUI RPC calls to pass the required empty input object for no-argument JSON-Schema methods.
- Added explicit JSON normalization before `ctx.storage.set(...)` so metrics/settings satisfy the 2.0.7 `Schema.Json` storage contract.
- Removed the unsupported `jev_compact` agent tool. OpenCode 2.0.7's public server-plugin `SessionDomain` does not expose `compact()`, even though the client/API has `session.compact`.
- Kept native automatic compaction and human `/compact` unchanged; both continue to reach the plugin's `compaction` hook.

## 0.0.2

Quality-first compaction policy and operator controls.

- Changed retention policy from generic keep/drop scoring to affirmative disposal proof.
- Added independent Jev judgments for exact evidence, unresolved blockers, completed work, repeat-work risk, truncation safety, supersession, and safe disposal.
- Added configurable `exactEvidenceThreshold`, `discardThreshold`, `supersededThreshold`, `uncertaintyMargin`, and `minConfidence`.
- Increased defaults for Jev state inspection and exact truncation heads.
- Added configurable `toolResultPreviewChars`.
- Lowered `minReductionRatio` default to 0.15 so useful conservative pruning can still win.
- Added `enabled` with a persistent runtime override.
- Added TUI `/jev-status`, `/jev-toggle`, and `/jev-reset` controls using server RPC.
- Removed the redundant `/jev-compact` command. Native `/compact` remains the manual user path.
- Added an experimental optional `jev_compact` agent tool. This was removed in 0.0.3 after validating the exact OpenCode 2.0.7 public plugin surface.
- Added bounded last-run/history metrics and estimated Jev input cost.
- Already-short sessions with no unpinned payload-bearing content now fall through without calling Jev.
- Expanded tests for conservative retention, disposal proof, preview fitting, history, failure fallback, and deterministic decisions.

## 0.0.1

Initial OpenCode v2 Jev compaction implementation.
