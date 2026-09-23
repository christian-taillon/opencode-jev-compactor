import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

import { normalizeOpenCodeMessages } from "../.test-dist/src/transcript/normalize.js"
import { isWeakFollowUp, parseCheckpointMarkdown, resolveObjective } from "../.test-dist/src/transcript/checkpoint-state.js"
import { buildJevState } from "../.test-dist/src/state/build.js"
import { fitState } from "../.test-dist/src/state/fit.js"
import { redactSecrets } from "../.test-dist/src/state/redact.js"
import { buildQuestionPlan } from "../.test-dist/src/jev/questions.js"
import { composeDecisions } from "../.test-dist/src/policy/compose.js"
import { reductionGate, semanticPayloadReduction } from "../.test-dist/src/policy/reduction.js"
import { assembleCheckpoint } from "../.test-dist/src/transcript/checkpoint.js"
import { parseJevResponse, JevMalformedResponseError } from "../.test-dist/src/jev/parse.js"
import { compactTranscript } from "../.test-dist/src/compaction/engine.js"
import { DEFAULT_OPTIONS, parseOptions } from "../.test-dist/src/plugin/options.js"
import { appendHistory, formatHistory, formatRun, makeRunRecord } from "../.test-dist/src/observability/history.js"
import { toJson } from "../.test-dist/src/observability/json.js"

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))
}

function noulAsker(answer) {
  return {
    async ask(state, questions) {
      return {
        response: {
          model: "jev-latest",
          answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => [
            id,
            { type: "noul", noul: answer(id, question, state) },
          ])),
          usage: { input_tokens: 1000, output_tokens: 0 },
        },
        latencyMs: 3,
      }
    },
  }
}

const discardAsker = noulAsker((id) => id === "verify" ? 0.95 : 0.05)
const truncateAsker = noulAsker((id) => id === "verify" ? 0.95 : id.includes("keep_call") ? 0.95 : 0.05)
const keepEverythingAsker = noulAsker(() => 0.95)

const composeOptions = {
  keepThreshold: DEFAULT_OPTIONS.keepThreshold,
  verificationThreshold: DEFAULT_OPTIONS.verificationThreshold,
  uncertaintyMargin: DEFAULT_OPTIONS.uncertaintyMargin,
}

test("0.0.5 options expose two-pass quality policy and tight request budgets", () => {
  const parsed = parseOptions({
    enabled: false,
    keepThreshold: 0.45,
    verificationThreshold: 0.9,
    uncertaintyMargin: 0.1,
    toolResultPreviewChars: 250,
    verificationResultPreviewChars: 12000,
    maxStateTokens: 23000,
    maxRequestTokens: 30000,
  })
  assert.equal(parsed.enabled, false)
  assert.equal(parsed.keepThreshold, 0.45)
  assert.equal(parsed.verificationThreshold, 0.9)
  assert.equal(parsed.toolResultPreviewChars, 250)
  assert.equal(parsed.verificationResultPreviewChars, 12000)
  assert.equal(parsed.maxRequestTokens, 30000)
  assert.equal(parseOptions({ maxRequestTokens: 60000 }).maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens)
})

test("storage JSON normalization removes undefined and rejects non-finite values", () => {
  assert.deepEqual(toJson({ enabled: true, omitted: undefined, nested: [{ value: 1, missing: undefined }] }), {
    enabled: true,
    nested: [{ value: 1 }],
  })
  assert.throws(() => toJson({ latency: Number.POSITIVE_INFINITY }), /non-finite/)
})

test("pinning keeps first, newest user, and recent messages", async () => {
  const raw = await fixture("tool-heavy-session.json")
  const transcript = normalizeOpenCodeMessages(raw, 2)
  assert.equal(transcript.messages[0].pinned, true)
  assert.equal(transcript.messages.at(-1).pinned, true)
  assert.equal(transcript.messages.at(-2).pinned, true)
  assert.equal(transcript.newestUserMessageId, "m6")
  assert.equal(transcript.messages.find((m) => m.id === "m2").pinned, false)
})

test("normalizer accepts exact OpenCode 2.0.7 Message tool and media parts", () => {
  const raw = [
    { id: "u1", role: "user", content: [
      { type: "text", text: "Fix /tmp/project/build.ts" },
      { type: "media", mediaType: "text/plain", filename: "build.ts", data: "embedded-data-must-not-be-retained" },
    ] },
    { id: "a1", role: "assistant", content: [
      { type: "text", text: "Checking the failure." },
      { type: "reasoning", text: "private chain of thought" },
      { type: "effort", effort: "high" },
      { type: "tool-call", id: "call-1", name: "shell", input: { command: "pnpm test" } },
    ] },
    { id: "t1", role: "tool", content: [
      { type: "tool-result", id: "call-1", name: "shell", result: { type: "error", value: "FAIL src/build.test.ts\nexit 1" } },
    ] },
  ]
  const transcript = normalizeOpenCodeMessages(raw, 1)
  assert.equal(transcript.toolCalls[0].toolName, "shell")
  assert.match(transcript.toolCalls[0].inputText, /pnpm test/)
  assert.equal(transcript.toolCalls[0].result.text, "FAIL src/build.test.ts\nexit 1")
  assert.equal(transcript.toolCalls[0].result.isError, true)
  assert.equal(transcript.attachments[0].descriptor, "media name=build.ts mediaType=text/plain")
  assert.doesNotMatch(transcript.attachments[0].descriptor, /embedded-data/)
  assert.doesNotMatch(transcript.textBlocks.map((block) => block.text).join("\n"), /chain of thought|effort/)
})

test("checkpoint parser extracts structured baseline without preserving the envelope", () => {
  const parsed = parseCheckpointMarkdown(`
## Objective
\`\`\`text
Continue the architecture explanation.
\`\`\`

## Decisions
- Do not repeat earlier material.
`)
  assert.ok(parsed)
  assert.equal(parsed.objective, "Continue the architecture explanation.")
  assert.equal(parsed.sections.Decisions, "- Do not repeat earlier material.")
})

test("normalizer treats prior checkpoint as baseline and excludes reasoning/control/old transcript", async () => {
  const raw = await fixture("false-positive-session.json")
  const transcript = normalizeOpenCodeMessages(raw, 0)
  const allText = transcript.textBlocks.map((block) => block.text).join("\n")
  assert.equal(
    transcript.previousCheckpoint?.objective,
    "Continue explaining the assistant’s architecture, capabilities, limitations, and alignment without repeating previously covered material.",
  )
  assert.doesNotMatch(allText, /Old material that should be represented only by the completed checkpoint/)
  assert.doesNotMatch(allText, /Planning discussion/)
  assert.doesNotMatch(allText, /conversation-checkpoint/)
})

test("weak follow-ups resolve to previous checkpoint objective", async () => {
  assert.equal(isWeakFollowUp("more more"), true)
  assert.equal(isWeakFollowUp("continue"), true)
  assert.equal(isWeakFollowUp("continue implementing src/index.ts"), false)
  const transcript = normalizeOpenCodeMessages(await fixture("false-positive-session.json"), 0)
  const objective = resolveObjective(transcript)
  assert.equal(objective?.source, "previous-checkpoint")
  assert.match(objective?.text ?? "", /Continue explaining the assistant/)
})

test("weak follow-up text is retained verbatim while an earlier objective is resolved", () => {
  const raw = [
    { id: "u1", role: "user", content: [{ type: "text", text: "Implement the exact migration." }] },
    { id: "a1", role: "assistant", content: [{ type: "text", text: "The implementation is in progress." }] },
    { id: "u2", role: "user", content: [{ type: "text", text: "continue" }] },
  ]
  const transcript = normalizeOpenCodeMessages(raw, 0)
  const built = buildJevState(transcript, { toolResultPreviewChars: 300 })
  const plan = buildQuestionPlan(built.state, transcript, built.constraints, built.files)
  const decisions = composeDecisions(
    transcript,
    built.state,
    built.objective,
    built.constraints,
    built.files,
    plan,
    {},
    composeOptions,
  )
  const summary = assembleCheckpoint(transcript, built.constraints, built.files, decisions, { truncateHeadChars: 600 })
  assert.equal(built.objective.text, "Implement the exact migration.")
  assert.match(summary, /```text\ncontinue\n```/)
})

test("Jev state is chronological and tool results are tiny previews without changing originals", () => {
  const raw = [
    { id: "m0", role: "user", content: [{ type: "text", text: "inspect" }] },
    { id: "m1", role: "assistant", content: [
      { type: "text", text: "Reading now." },
      { type: "tool-call", toolCallId: "t1", toolName: "read", input: { path: "src/x.ts" } },
    ] },
    { id: "m2", role: "tool", content: [{ type: "tool-result", toolCallId: "t1", output: "z".repeat(5000) }] },
  ]
  const transcript = normalizeOpenCodeMessages(raw, 0)
  const built = buildJevState(transcript, { toolResultPreviewChars: 300 })
  assert.equal(transcript.toolCalls[0].result.text.length, 5000)
  assert.deepEqual(built.state.history.map((entry) => entry.messageId), ["m0", "m1"])
  const tool = built.state.history[1].tool_calls[0]
  assert.equal(typeof tool, "object")
  assert.equal(tool.result.chars, 5000)
  assert.ok(tool.result.preview.length < 500)
})

test("state fitting aggressively collapses old Jev-only history", () => {
  const state = {
    context: "compact",
    goal: "finish",
    baseline: null,
    history: [
      { i: 0, messageId: "m0", role: "user", text: "goal", pinned: true },
      {
        i: 1,
        messageId: "m1",
        role: "assistant",
        text: "a".repeat(10000),
        pinned: false,
        tool_calls: [{
          id: "t1",
          name: "read",
          input: "x".repeat(5000),
          result: { status: "ok", chars: 50000, preview: "z".repeat(300) },
          pinned: false,
        }],
      },
      { i: 2, messageId: "m2", role: "assistant", text: "b".repeat(10000), pinned: false },
    ],
  }
  const original = structuredClone(state)
  const fitted = fitState(state, { maxStateChars: 3000, maxStateTokens: 3000 })
  assert.equal(fitted.ok, true)
  assert.notEqual(fitted.stage, "full")
  assert.ok(fitted.state.history.length <= 3)
  assert.deepEqual(state, original)
})

test("secret redaction removes obvious credentials", () => {
  const source = 'Authorization: Bearer abc.def.ghi\napi_key="supersecretvalue123"\nghop_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'
  const result = redactSecrets(source)
  assert.ok(result.count >= 2)
  assert.doesNotMatch(result.text, /abc\.def\.ghi|supersecretvalue123/)
})

function buildToolHarness() {
  const raw = [
    { id: "m0", role: "user", content: [{ type: "text", text: "Fix the build." }] },
    { id: "m1", role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "shell", input: { command: "npm test" } }] },
    { id: "m2", role: "tool", content: [{ type: "tool-result", toolCallId: "t1", output: "failure output" }] },
    { id: "m3", role: "user", content: [{ type: "text", text: "Continue with the current failure." }] },
  ]
  const transcript = normalizeOpenCodeMessages(raw, 1)
  const built = buildJevState(transcript, { toolResultPreviewChars: 300 })
  const plan = buildQuestionPlan(built.state, transcript, built.constraints, built.files)
  const ids = plan.tools.get("t1")
  assert.ok(ids)
  const decide = (keepCall, keepResult, verify) => {
    const answers = {
      [ids.keepCall]: { type: "noul", noul: keepCall },
      [ids.keepResult]: { type: "noul", noul: keepResult },
    }
    const verification = verify === undefined ? new Map() : new Map([["t1", verify]])
    return composeDecisions(
      transcript,
      built.state,
      built.objective,
      built.constraints,
      built.files,
      plan,
      answers,
      composeOptions,
      verification,
    ).tools.find((item) => item.toolCallId === "t1")
  }
  return { decide, plan }
}

test("tool first pass is exactly two narrow questions", () => {
  const { plan } = buildToolHarness()
  assert.equal(plan.tools.size, 1)
  assert.equal(Object.keys(plan.questions).length, 2)
})

test("exact-result retention keeps full tool evidence", () => {
  const { decide } = buildToolHarness()
  assert.equal(decide(0.1, 0.9, undefined).decision, "keep_full")
})

test("verified provenance candidate truncates result", () => {
  const { decide } = buildToolHarness()
  assert.equal(decide(0.9, 0.1, 0.95).decision, "keep_call_truncate_result")
})

test("verified disposable candidate drops call and result", () => {
  const { decide } = buildToolHarness()
  assert.equal(decide(0.1, 0.1, 0.95).decision, "drop")
})

test("failed or uncertain verification fails toward full retention", () => {
  const { decide } = buildToolHarness()
  assert.equal(decide(0.1, 0.1, 0.2).decision, "keep_full")
  assert.equal(decide(0.1, 0.1, 0.5).decision, "keep_full")
})

test("all conversational text is preserved by default", () => {
  const { decide } = buildToolHarness()
  assert.ok(decide(0.1, 0.1, 0.95))
  const raw = [
    { id: "m0", role: "user", content: [{ type: "text", text: "Keep this exact request." }] },
    { id: "m1", role: "assistant", content: [{ type: "text", text: "Keep this exact explanation." }] },
  ]
  const transcript = normalizeOpenCodeMessages(raw, 0)
  const built = buildJevState(transcript, { toolResultPreviewChars: 300 })
  const plan = buildQuestionPlan(built.state, transcript, built.constraints, built.files)
  const decisions = composeDecisions(transcript, built.state, built.objective, built.constraints, built.files, plan, {}, composeOptions)
  assert.equal(decisions.texts.every((item) => item.keep), true)
})

test("checkpoint keeps text verbatim and truncates tool result by exact head", () => {
  const raw = [
    { id: "m0", role: "user", content: [{ type: "text", text: "Exact user text\nwith spacing." }] },
    { id: "m1", role: "assistant", content: [{ type: "text", text: "Exact assistant text." }, { type: "tool-call", toolCallId: "t1", toolName: "shell", input: { command: "cat /tmp/x" } }] },
    { id: "m2", role: "tool", content: [{ type: "tool-result", toolCallId: "t1", output: "A".repeat(1000) + "TAIL" }] },
  ]
  const transcript = normalizeOpenCodeMessages(raw, 0)
  const built = buildJevState(transcript, { toolResultPreviewChars: 300 })
  const summary = assembleCheckpoint(transcript, built.constraints, built.files, {
    objectiveText: "Exact user text\nwith spacing.",
    objectiveTextId: "m0:text:0",
    tools: [{ toolCallId: "t1", decision: "keep_call_truncate_result", reason: "jev" }],
    texts: transcript.textBlocks.map((block) => ({ textId: block.id, keep: true, category: block.id === "m0:text:0" ? "objective" : "evidence", reason: "jev" })),
    constraints: built.constraints.map((candidate) => ({ id: candidate.id, keep: true, probability: 1 })),
    files: built.files.map((candidate) => ({ id: candidate.id, keep: true, probability: 1 })),
  }, { truncateHeadChars: 80 })
  assert.ok(summary.includes("Exact user text\nwith spacing."))
  assert.ok(summary.includes("Exact assistant text."))
  assert.ok(summary.includes("A".repeat(80)))
  assert.ok(!summary.includes("TAIL"))
})

test("semantic payload gate ignores JSON-to-Markdown representation changes", () => {
  const raw = [
    { id: "m0", role: "user", content: [{ type: "text", text: "Goal" }] },
    { id: "m1", role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "read", input: { path: "x" } }] },
    { id: "m2", role: "tool", content: [{ type: "tool-result", toolCallId: "t1", output: "x".repeat(1000) }] },
  ]
  const transcript = normalizeOpenCodeMessages(raw, 0)
  const decisions = {
    tools: [{ toolCallId: "t1", decision: "drop", reason: "jev" }],
    texts: transcript.textBlocks.map((block) => ({ textId: block.id, keep: true, category: "evidence", reason: "jev" })),
    constraints: [],
    files: [],
  }
  const semantic = semanticPayloadReduction(transcript, decisions, 100, 0.15)
  assert.ok(semantic.removedFraction > 0.9)
  assert.equal(semantic.sufficient, true)
  assert.equal(reductionGate(1000, 900, 0.15).sufficient, false)
})

test("malformed Jev payload is rejected", async () => {
  const raw = await fixture("malformed-jev.json")
  assert.throws(() => parseJevResponse(raw, { q: { type: "choice", instructions: "choose", criteria: { a: "A", b: "B" } } }), JevMalformedResponseError)
})

test("tool-heavy engine prunes stale traces with destructive-action verification", async () => {
  const raw = await fixture("tool-heavy-session.json")
  const outcome = await compactTranscript(raw, discardAsker, { ...DEFAULT_OPTIONS, preserveRecentMessages: 2, timeoutMs: 1000 })
  assert.equal(outcome.status, "ok")
  assert.ok(outcome.checkpoint.stats.toolsDropped >= 2)
  assert.ok(outcome.checkpoint.stats.verificationRequests >= 2)
  assert.ok(outcome.checkpoint.stats.semanticRemovedFraction >= DEFAULT_OPTIONS.minReductionRatio)
  assert.equal(outcome.checkpoint.stats.textsDropped, 0)
  assert.equal(outcome.checkpoint.stats.estimatedJevCostUsd, outcome.checkpoint.stats.jevInputTokens / 1_000_000 * 0.042)
  assert.ok(outcome.checkpoint.summary.includes("Do not target v1. Next, wire the v2 compaction hook."))
  assert.ok(outcome.checkpoint.summary.includes("I will inspect the old client."))
  assert.ok(!outcome.checkpoint.summary.includes("OLD CLIENT"))
})

test("engine can retain tool provenance while truncating bulky results", async () => {
  const raw = await fixture("tool-heavy-session.json")
  const outcome = await compactTranscript(raw, truncateAsker, { ...DEFAULT_OPTIONS, preserveRecentMessages: 2, timeoutMs: 1000 })
  assert.equal(outcome.status, "ok")
  assert.ok(outcome.checkpoint.stats.toolsTruncated >= 2)
  assert.equal(outcome.checkpoint.stats.toolsDropped, 0)
  assert.match(outcome.checkpoint.summary, /checkpoint truncation:/)
})

test("keep-everything Jev run safely falls back with no semantic reduction", async () => {
  const raw = await fixture("tool-heavy-session.json")
  const outcome = await compactTranscript(raw, keepEverythingAsker, {
    ...DEFAULT_OPTIONS,
    preserveRecentMessages: 2,
    minReductionRatio: 0,
    timeoutMs: 1000,
  })
  assert.equal(outcome.status, "fallback")
  assert.equal(outcome.reason, "no-semantic-reduction")
  assert.equal(outcome.stats.semanticReductionActions, 0)
  assert.equal(outcome.stats.textsDropped, 0)
})

test("verification evidence that cannot fit the request budget fails toward keep-full", async () => {
  const raw = await fixture("tool-heavy-session.json")
  raw.splice(1, 0, {
    id: "padding",
    role: "assistant",
    content: [{ type: "text", text: "word ".repeat(4000) }],
  })
  let verificationAnswers = 0
  const asker = noulAsker((id) => {
    if (id === "verify") verificationAnswers += 1
    return id === "verify" ? 0.95 : 0.05
  })
  const outcome = await compactTranscript(raw, asker, {
    ...DEFAULT_OPTIONS,
    preserveRecentMessages: 2,
    maxRequestTokens: 5000,
    timeoutMs: 1000,
  })
  assert.equal(outcome.status, "fallback")
  assert.equal(outcome.reason, "no-semantic-reduction")
  assert.ok(outcome.stats.jevRequests > 0)
  assert.equal(outcome.stats.verificationRequests, 0)
  assert.equal(verificationAnswers, 0)
  assert.equal(outcome.stats.toolsKeptFull, 2)
  assert.equal(outcome.stats.toolDecisionDiagnostics.every((item) => item.verification === undefined), true)
})

test("weak objective with no substantive request falls back before Jev", async () => {
  let calls = 0
  const outcome = await compactTranscript(
    [{ id: "u1", role: "user", content: [{ type: "text", text: "more" }] }],
    { async ask() { calls += 1; throw new Error("should not be called") } },
    { ...DEFAULT_OPTIONS, preserveRecentMessages: 0, timeoutMs: 1000 },
  )
  assert.equal(outcome.status, "fallback")
  assert.equal(outcome.reason, "weak-objective-unresolved")
  assert.equal(calls, 0)
})

test("text-only short session is nothing-prunable and never calls Jev", async () => {
  const raw = await fixture("small-session.json")
  let calls = 0
  const outcome = await compactTranscript(raw, { async ask() { calls += 1; throw new Error("should not be called") } }, { ...DEFAULT_OPTIONS, preserveRecentMessages: 0 })
  assert.equal(outcome.status, "fallback")
  assert.equal(outcome.reason, "nothing-prunable")
  assert.equal(calls, 0)
  assert.ok(outcome.stats.semanticPayloadCharsBefore > 0)
  assert.equal(outcome.stats.semanticPayloadCharsAfter, outcome.stats.semanticPayloadCharsBefore)
})

test("Jev failure safely falls back", async () => {
  const raw = await fixture("tool-heavy-session.json")
  const outcome = await compactTranscript(raw, { async ask() { throw new Error("network unavailable") } }, { ...DEFAULT_OPTIONS, preserveRecentMessages: 2, timeoutMs: 1000 })
  assert.equal(outcome.status, "fallback")
  assert.match(outcome.reason, /^jev-/)
})

test("state that cannot fit falls back before Jev", async () => {
  const raw = await fixture("tool-heavy-session.json")
  let calls = 0
  const outcome = await compactTranscript(raw, { async ask() { calls += 1; throw new Error("should not be called") } }, {
    ...DEFAULT_OPTIONS,
    maxStateChars: 200,
    maxStateTokens: 50,
    preserveRecentMessages: 2,
  })
  assert.equal(outcome.status, "fallback")
  assert.equal(outcome.reason, "state-cannot-fit")
  assert.equal(calls, 0)
})

test("same state and Jev answers produce identical decisions", async () => {
  const raw = await fixture("tool-heavy-session.json")
  const options = { ...DEFAULT_OPTIONS, preserveRecentMessages: 2, timeoutMs: 1000 }
  const first = await compactTranscript(raw, discardAsker, options)
  const second = await compactTranscript(raw, discardAsker, options)
  assert.equal(first.status, "ok")
  assert.equal(second.status, "ok")
  assert.deepEqual(second.decisions, first.decisions)
  assert.equal(second.checkpoint.summary, first.checkpoint.summary)
})

test("history exposes semantic metrics and bounded per-tool diagnostics", () => {
  const stats = {
    pluginVersion: "0.0.5",
    sessionID: "ses_test",
    originalEstimatedTokens: 100000,
    checkpointEstimatedTokens: 20000,
    removedFraction: 0.8,
    remainingRatio: 0.2,
    semanticPayloadCharsBefore: 100000,
    semanticPayloadCharsAfter: 30000,
    semanticRemovedFraction: 0.7,
    fittedStateEstimatedTokens: 20000,
    fittedStateChars: 70000,
    fitStage: "old-calls-compacted",
    jevRequests: 3,
    verificationRequests: 2,
    jevInputTokens: 60000,
    jevOutputTokens: 0,
    jevLatencyMs: 900,
    estimatedJevCostUsd: 0.00252,
    toolsScored: 2,
    toolsKeptFull: 0,
    toolsTruncated: 1,
    toolsDropped: 1,
    textsScored: 0,
    textsKept: 5,
    textsDropped: 0,
    semanticReductionActions: 2,
    toolDecisionDiagnostics: [
      { toolCallId: "t1", toolName: "read", action: "drop", reason: "jev", keepCall: 0.1, keepResult: 0.1, verification: 0.95 },
    ],
    redactions: 0,
  }
  const record = makeRunRecord("ok", null, stats, "2026-01-02T00:00:00Z")
  assert.match(formatRun(record), /historical plugin 0\.0\.5/)
  assert.match(formatRun(record), /semantic payload 100,000 -> 30,000 chars; removed 70\.0%/)
  assert.match(formatRun(record), /Jev state 70,000 chars \/ 20,000 tokens; fit old-calls-compacted/)
  assert.match(formatRun(record), /t1:read:drop\/call=0\.10\/result=0\.10\/verify=0\.95/)

  const legacyStats = { ...stats }
  for (const key of [
    "pluginVersion",
    "sessionID",
    "semanticPayloadCharsBefore",
    "semanticPayloadCharsAfter",
    "semanticRemovedFraction",
    "verificationRequests",
    "toolDecisionDiagnostics",
  ]) delete legacyStats[key]
  assert.match(formatRun(makeRunRecord("ok", null, legacyStats, "2025-01-01T00:00:00Z")), /plugin pre-0\.0\.5/)
  const history = appendHistory(
    [makeRunRecord("ok", null, stats, "2026-01-01T00:00:00Z"), record],
    makeRunRecord("fallback", "no-semantic-reduction", stats, "2026-01-03T00:00:00Z"),
    2,
  )
  assert.equal(history.length, 2)
  assert.doesNotMatch(formatHistory(history), /2026-01-01/)
})
