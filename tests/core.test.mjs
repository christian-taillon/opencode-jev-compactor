import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

import { normalizeOpenCodeMessages } from "../.test-dist/src/transcript/normalize.js"
import { buildJevState } from "../.test-dist/src/state/build.js"
import { fitState } from "../.test-dist/src/state/fit.js"
import { redactSecrets } from "../.test-dist/src/state/redact.js"
import { buildQuestionPlan } from "../.test-dist/src/jev/questions.js"
import { composeDecisions } from "../.test-dist/src/policy/compose.js"
import { reductionGate } from "../.test-dist/src/policy/reduction.js"
import { assembleCheckpoint } from "../.test-dist/src/transcript/checkpoint.js"
import { parseJevResponse, JevMalformedResponseError } from "../.test-dist/src/jev/parse.js"
import { compactTranscript } from "../.test-dist/src/compaction/engine.js"
import { DEFAULT_OPTIONS, parseOptions } from "../.test-dist/src/plugin/options.js"
import { appendHistory, formatHistory, makeRunRecord } from "../.test-dist/src/observability/history.js"
import { toJson } from "../.test-dist/src/observability/json.js"

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))
}

function scoreAnswer(score = 0, confidence = 0.95) {
  return {
    type: "score",
    score,
    confidence,
    probabilities: { "0": score === 0 ? 0.9 : 0.025, "1": 0.025, "2": 0.025, "3": 0.025, "4": score === 4 ? 0.9 : 0.025 },
    legend: { "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four" },
  }
}

function choiceAnswer(question, selected, confidence = 0.95) {
  const keys = Object.keys(question.criteria)
  return {
    type: "choice",
    choice: selected,
    confidence,
    probabilities: Object.fromEntries(keys.map((key) => [key, key === selected ? 0.9 : 0.1 / Math.max(1, keys.length - 1)])),
  }
}

function aggressiveDiscardAnswer(id, question) {
  if (question.type === "noul") {
    if (id.includes("safe_to_discard") || id.includes("superseded") || id.includes("truncate_safe")) return { type: "noul", noul: 0.95 }
    if (id.includes("constraint_") || id.includes("file_")) return { type: "noul", noul: 0.9 }
    return { type: "noul", noul: 0.05 }
  }
  if (question.type === "score") return scoreAnswer(0)
  const keys = Object.keys(question.criteria)
  if (keys.includes("drop")) return choiceAnswer(question, "drop")
  if (keys.includes("irrelevant")) return choiceAnswer(question, "irrelevant")
  const candidates = keys.filter((key) => key.startsWith("candidate_"))
  return choiceAnswer(question, candidates.at(-1) ?? keys[0])
}

const aggressiveDiscardAsker = {
  async ask(_state, questions) {
    return {
      response: {
        model: "jev-latest",
        answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, aggressiveDiscardAnswer(id, question)])),
        usage: { input_tokens: 1000, output_tokens: 0 },
      },
      latencyMs: 3,
    }
  },
}

const composeOptions = {
  keepThreshold: DEFAULT_OPTIONS.keepThreshold,
  exactEvidenceThreshold: DEFAULT_OPTIONS.exactEvidenceThreshold,
  discardThreshold: DEFAULT_OPTIONS.discardThreshold,
  supersededThreshold: DEFAULT_OPTIONS.supersededThreshold,
  uncertaintyMargin: DEFAULT_OPTIONS.uncertaintyMargin,
  minConfidence: DEFAULT_OPTIONS.minConfidence,
}

test("0.0.3 options expose quality-first thresholds with safe validation", () => {
  const parsed = parseOptions({
    enabled: false,
    keepThreshold: 0.4,
    exactEvidenceThreshold: 0.42,
    discardThreshold: 0.88,
    supersededThreshold: 0.8,
    uncertaintyMargin: 0.1,
    minConfidence: 0.6,
    toolResultPreviewChars: 12000,
    truncateHeadChars: 900,
    historyLimit: 20,
    jevInputCostPerMillionUsd: 0.042,
  })
  assert.equal(parsed.enabled, false)
  assert.equal(parsed.discardThreshold, 0.88)
  assert.equal(parsed.toolResultPreviewChars, 12000)
  assert.equal(parseOptions({ discardThreshold: 0.1 }).discardThreshold, DEFAULT_OPTIONS.discardThreshold)
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
  assert.equal(transcript.messages.find((m) => m.id === "m6").pinned, true)
  assert.equal(transcript.messages.find((m) => m.id === "m2").pinned, false)
})

test("normalizer accepts native OpenCode v2 assistant tool-state messages", () => {
  const raw = [
    { id: "u1", type: "user", text: "Fix /tmp/project/build.ts", files: [{ type: "file", path: "/tmp/project/build.ts" }] },
    { id: "a1", type: "assistant", content: [
      { type: "text", text: "Checking the failure." },
      { type: "tool", id: "call-1", name: "shell", state: { status: "error", input: { command: "npm test" }, error: { message: "exit 1" }, content: [{ type: "text", text: "FAIL src/build.test.ts" }] } },
    ] },
  ]
  const transcript = normalizeOpenCodeMessages(raw, 1)
  assert.equal(transcript.messages[0].role, "user")
  assert.equal(transcript.toolCalls[0].toolName, "shell")
  assert.match(transcript.toolCalls[0].inputText, /npm test/)
  assert.equal(transcript.toolCalls[0].result.isError, true)
  assert.match(transcript.toolCalls[0].result.text, /FAIL src\/build\.test\.ts/)
  assert.match(transcript.attachments[0].descriptor, /path=\/tmp\/project\/build\.ts/)
})

test("Jev tool-result preview length is configurable without changing original local result", () => {
  const raw = [
    { id: "m0", role: "user", content: [{ type: "text", text: "inspect" }] },
    { id: "m1", role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "read", input: { path: "x" } }] },
    { id: "m2", role: "tool", content: [{ type: "tool-result", toolCallId: "t1", output: "z".repeat(5000) }] },
  ]
  const transcript = normalizeOpenCodeMessages(raw, 0)
  const built = buildJevState(transcript, { toolResultPreviewChars: 700 })
  assert.equal(transcript.toolCalls[0].result.text.length, 5000)
  assert.equal(built.state.tools[0].resultPreviewTruncated, true)
  assert.ok(built.state.tools[0].result.length < 900)
})

test("state fitting abbreviates results before older assistant text", () => {
  const state = {
    goal: "finish",
    objectiveCandidates: [{ id: "m9", text: "finish" }],
    recentTurns: [],
    textBlocks: [{ id: "b1", messageId: "m1", role: "assistant", text: "short", pinned: false, source: "text-part" }],
    tools: [{ id: "t1", name: "read", call: "{}", result: "z".repeat(15000), resultChars: 15000, resultPreviewTruncated: false, isError: false, pinned: false }],
    files: [],
    constraints: [],
  }
  const result = fitState(state, { maxStateChars: 5000, maxStateTokens: 5000 })
  assert.equal(result.ok, true)
  assert.match(result.stage, /^results-/)
  assert.equal(result.state.textBlocks[0].text, "short")
})

test("secret redaction removes obvious credentials", () => {
  const source = 'Authorization: Bearer abc.def.ghi\napi_key="supersecretvalue123"\nghop_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'
  const result = redactSecrets(source)
  assert.ok(result.count >= 2)
  assert.doesNotMatch(result.text, /abc\.def\.ghi|supersecretvalue123/)
})

function buildToolCompositionHarness() {
  const raw = [
    { id: "m0", role: "user", content: [{ type: "text", text: "Fix the build." }] },
    { id: "m1", role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "shell", input: { command: "npm test" } }] },
    { id: "m2", role: "tool", content: [{ type: "tool-result", toolCallId: "t1", output: "failure output" }] },
    { id: "m3", role: "user", content: [{ type: "text", text: "Continue with the current failure." }] },
  ]
  const transcript = normalizeOpenCodeMessages(raw, 1)
  const built = buildJevState(transcript, { toolResultPreviewChars: 8000 })
  const plan = buildQuestionPlan(built.state, transcript, built.constraints, built.files)
  const ids = plan.tools.get("t1")
  assert.ok(ids)
  const base = Object.fromEntries(Object.entries(plan.questions).map(([id, question]) => [id, aggressiveDiscardAnswer(id, question)]))
  const decide = (overrides) => composeDecisions(
    transcript, built.state, built.constraints, built.files, plan, { ...base, ...overrides }, composeOptions,
  ).tools.find((item) => item.toolCallId === "t1").decision
  return { ids, plan, decide }
}

test("exact evidence forces full tool retention", () => {
  const { ids, decide } = buildToolCompositionHarness()
  assert.equal(decide({ [ids.exactEvidence]: { type: "noul", noul: 0.95 } }), "keep_full")
})

test("completed-work or repeat-work risk preserves at least truncated provenance", () => {
  const { ids, decide } = buildToolCompositionHarness()
  assert.equal(decide({
    [ids.completedWork]: { type: "noul", noul: 0.95 },
    [ids.safeToDiscard]: { type: "noul", noul: 0.05 },
    [ids.truncateSafe]: { type: "noul", noul: 0.95 },
  }), "keep_call_truncate_result")
})

test("drop requires affirmative disposal proof", () => {
  const { decide } = buildToolCompositionHarness()
  assert.equal(decide({}), "drop")
})

test("uncertain exact-evidence judgment fails toward keep_full", () => {
  const { ids, decide } = buildToolCompositionHarness()
  assert.equal(decide({ [ids.exactEvidence]: { type: "noul", noul: 0.5 } }), "keep_full")
})

test("checkpoint keeps retained text verbatim and truncates tool result by exact head", () => {
  const raw = [
    { id: "m0", role: "user", content: [{ type: "text", text: "Exact user text\nwith spacing." }] },
    { id: "m1", role: "assistant", content: [{ type: "text", text: "Exact assistant text." }, { type: "tool-call", toolCallId: "t1", toolName: "shell", input: { command: "cat /tmp/x" } }] },
    { id: "m2", role: "tool", content: [{ type: "tool-result", toolCallId: "t1", output: "A".repeat(1000) + "TAIL" }] },
  ]
  const transcript = normalizeOpenCodeMessages(raw, 0)
  const built = buildJevState(transcript, { toolResultPreviewChars: 8000 })
  const summary = assembleCheckpoint(transcript, built.constraints, built.files, {
    objectiveTextId: "m0:text:0",
    tools: [{ toolCallId: "t1", decision: "keep_call_truncate_result", reason: "jev" }],
    texts: transcript.textBlocks.map((block) => ({ textId: block.id, keep: true, category: block.role === "user" ? "objective" : "active", reason: "jev" })),
    constraints: [], files: [],
  }, { truncateHeadChars: 80 })
  assert.ok(summary.includes("Exact user text\nwith spacing."))
  assert.ok(summary.includes("Exact assistant text."))
  assert.ok(summary.includes("A".repeat(80)))
  assert.ok(!summary.includes("TAIL"))
  assert.match(summary, /checkpoint truncation:/)
})

test("reduction gate interprets ratio as fraction removed", () => {
  assert.equal(reductionGate(1000, 800, 0.15).sufficient, true)
  assert.equal(reductionGate(1000, 900, 0.15).sufficient, false)
})

test("malformed Jev payload is rejected", async () => {
  const raw = await fixture("malformed-jev.json")
  assert.throws(() => parseJevResponse(raw, { q: { type: "choice", instructions: "choose", criteria: { a: "A", b: "B" } } }), JevMalformedResponseError)
})

test("tool-heavy engine can prune stale traces and records tiny Jev estimated cost", async () => {
  const raw = await fixture("tool-heavy-session.json")
  const outcome = await compactTranscript(raw, aggressiveDiscardAsker, { ...DEFAULT_OPTIONS, preserveRecentMessages: 2, timeoutMs: 1000 })
  assert.equal(outcome.status, "ok")
  assert.ok(outcome.checkpoint.stats.toolsDropped >= 2)
  assert.ok(outcome.checkpoint.stats.removedFraction >= DEFAULT_OPTIONS.minReductionRatio)
  assert.equal(outcome.checkpoint.stats.estimatedJevCostUsd, outcome.checkpoint.stats.jevInputTokens / 1_000_000 * 0.042)
  assert.ok(outcome.checkpoint.summary.includes("Do not target v1. Next, wire the v2 compaction hook."))
  assert.ok(!outcome.checkpoint.summary.includes("OLD CLIENT"))
})

test("already-short session safely falls back", async () => {
  const raw = await fixture("small-session.json")
  const outcome = await compactTranscript(raw, aggressiveDiscardAsker, { ...DEFAULT_OPTIONS, preserveRecentMessages: 6, timeoutMs: 1000 })
  assert.equal(outcome.status, "fallback")
  assert.ok(["insufficient-reduction", "nothing-to-score", "nothing-prunable"].includes(outcome.reason))
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
    toolResultPreviewChars: 50000,
  })
  assert.equal(outcome.status, "fallback")
  assert.equal(outcome.reason, "state-cannot-fit")
  assert.equal(calls, 0)
})

test("same state and Jev answers produce identical decisions", async () => {
  const raw = await fixture("tool-heavy-session.json")
  const options = { ...DEFAULT_OPTIONS, preserveRecentMessages: 2, timeoutMs: 1000 }
  const first = await compactTranscript(raw, aggressiveDiscardAsker, options)
  const second = await compactTranscript(raw, aggressiveDiscardAsker, options)
  assert.equal(first.status, "ok")
  assert.equal(second.status, "ok")
  assert.deepEqual(second.decisions, first.decisions)
  assert.equal(second.checkpoint.summary, first.checkpoint.summary)
})

test("history is bounded and formats useful metrics", () => {
  const stats = {
    originalEstimatedTokens: 100000, checkpointEstimatedTokens: 20000, removedFraction: 0.8, remainingRatio: 0.2,
    fittedStateEstimatedTokens: 20000, fittedStateChars: 70000, fitStage: "none", jevRequests: 3, jevInputTokens: 60000,
    jevOutputTokens: 0, jevLatencyMs: 900, estimatedJevCostUsd: 0.00252, toolsScored: 20, toolsKeptFull: 4,
    toolsTruncated: 6, toolsDropped: 10, textsScored: 10, textsKept: 5, textsDropped: 5, redactions: 0,
  }
  const history = appendHistory(
    [makeRunRecord("ok", null, stats, "2026-01-01T00:00:00Z"), makeRunRecord("ok", null, stats, "2026-01-02T00:00:00Z")],
    makeRunRecord("fallback", "insufficient-reduction", stats, "2026-01-03T00:00:00Z"),
    2,
  )
  assert.equal(history.length, 2)
  const formatted = formatHistory(history)
  assert.equal(formatted.split("\n").length, 2)
  assert.match(formatted, /\$0\.002520/)
  assert.doesNotMatch(formatted, /2026-01-01/)
})
