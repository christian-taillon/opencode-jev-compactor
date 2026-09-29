# Changelog

## Unreleased

- Added conventional root entrypoints so OpenCode 2.0.7 can discover all server, TUI, and RPC features when the repository is configured as a local plugin directory.
- Mounted TUI keymap registration inside the application slot to ensure the OpenCode keymap provider exists during registration.
- Made `/jev-status` easier to read with an extra-large dialog, one detailed latest run, and compact previous-run summaries.
- Documented the 0.0.3 `state-cannot-fit` fallback for transcripts that exceed the single fitted Jev-state ceiling.

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
