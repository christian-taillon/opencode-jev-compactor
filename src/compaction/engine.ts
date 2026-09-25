import type {
  CompactionOutcome,
  CompactionStats,
  JsonValue,
  ToolDecisionDiagnostic,
} from "../domain/types.js"
import { batchQuestions, type QuestionBatch } from "../jev/batch.js"
import { buildQuestionPlan } from "../jev/questions.js"
import type { JevAnswer, JevBatchResult, JevQuestion } from "../jev/types.js"
import { toJson } from "../observability/json.js"
import { composeDecisions } from "../policy/compose.js"
import {
  prunablePayloadCapacity,
  reductionGate,
  semanticPayloadChars,
  semanticPayloadReduction,
} from "../policy/reduction.js"
import type { PluginOptions } from "../plugin/options.js"
import { buildJevState } from "../state/build.js"
import { estimateJsonTokens, estimateTokens } from "../state/estimate.js"
import { fitState } from "../state/fit.js"
import { assembleCheckpoint } from "../transcript/checkpoint.js"
import { normalizeOpenCodeMessages } from "../transcript/normalize.js"

export interface JevAsker {
  ask(state: JsonValue, questions: Record<string, JevQuestion>, signal?: AbortSignal): Promise<JevBatchResult>
}

export const PLUGIN_VERSION = "0.0.7"

export function initialCompactionStats(rawMessages: readonly unknown[], sessionID?: string): CompactionStats {
  return {
    ...(sessionID ? { sessionID } : {}),
    pluginVersion: PLUGIN_VERSION,
    originalEstimatedTokens: estimateJsonTokens(rawMessages),
    checkpointEstimatedTokens: 0,
    removedFraction: 0,
    remainingRatio: 1,
    semanticPayloadCharsBefore: 0,
    semanticPayloadCharsAfter: 0,
    semanticRemovedFraction: 0,
    maxPrunablePayloadChars: 0,
    maxPrunableFraction: 0,
    eligiblePrunableTools: 0,
    fittedStateEstimatedTokens: 0,
    fittedStateChars: 0,
    fitStage: "none",
    jevRequests: 0,
    verificationRequests: 0,
    jevInputTokens: 0,
    jevOutputTokens: 0,
    jevLatencyMs: 0,
    estimatedJevCostUsd: 0,
    toolsScored: 0,
    toolsKeptFull: 0,
    toolsTruncated: 0,
    toolsDropped: 0,
    textsScored: 0,
    textsKept: 0,
    textsDropped: 0,
    semanticReductionActions: 0,
    toolDecisionDiagnostics: [],
    redactions: 0,
  }
}

function fallback(stats: CompactionStats, reason: string): CompactionOutcome {
  return { status: "fallback", reason, stats: { ...stats, fallbackReason: reason } }
}

function internalError(stats: CompactionStats, error: unknown): CompactionOutcome {
  const type = error instanceof Error ? error.name : "Error"
  const reason = `internal-${type}`
  return { status: "error", reason, stats: { ...stats, fallbackReason: reason } }
}

function mergeAnswers(target: Record<string, JevAnswer>, source: Record<string, JevAnswer>): void {
  for (const [id, value] of Object.entries(source)) {
    if (target[id]) throw new Error(`duplicate Jev answer ${id}`)
    target[id] = value
  }
}

function linkedAbort(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error("compaction timeout")), timeoutMs)
  const onAbort = () => controller.abort(parent?.reason ?? new Error("compaction aborted"))
  if (parent) {
    if (parent.aborted) onAbort()
    else parent.addEventListener("abort", onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      parent?.removeEventListener("abort", onAbort)
    },
  }
}

async function askBatches(
  batches: readonly QuestionBatch[],
  state: JsonValue,
  asker: JevAsker,
  signal: AbortSignal,
  maxConcurrentRequests: number,
): Promise<JevBatchResult[]> {
  const results = new Array<JevBatchResult>(batches.length)
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(maxConcurrentRequests, batches.length) },
    async () => {
      while (true) {
        const index = cursor++
        const batch = batches[index]
        if (!batch) return
        results[index] = await asker.ask(state, batch.questions, signal)
      }
    },
  )
  await Promise.all(workers)
  return results
}

function diagnostics(
  transcript: ReturnType<typeof normalizeOpenCodeMessages>,
  decisions: ReturnType<typeof composeDecisions>,
): ToolDecisionDiagnostic[] {
  const names = new Map(transcript.toolCalls.map((call) => [call.id, call.toolName] as const))
  return decisions.tools.map((item) => ({
    toolCallId: item.toolCallId,
    toolName: names.get(item.toolCallId) ?? "unknown",
    action: item.decision,
    reason: item.reason,
    ...(item.signals ? {
      ...(item.signals.keepCall !== undefined ? { keepCall: item.signals.keepCall } : {}),
      keepResult: item.signals.keepResult,
    } : {}),
  }))
}

function applyDecisionStats(
  stats: CompactionStats,
  transcript: ReturnType<typeof normalizeOpenCodeMessages>,
  decisions: ReturnType<typeof composeDecisions>,
  truncateHeadChars: number,
): void {
  stats.toolsKeptFull = decisions.tools.filter((item) => item.decision === "keep_full").length
  stats.toolsTruncated = decisions.tools.filter((item) => item.decision === "keep_call_truncate_result").length
  stats.toolsDropped = decisions.tools.filter((item) => item.decision === "drop").length
  stats.textsKept = decisions.texts.filter((item) => item.keep).length
  stats.textsDropped = decisions.texts.filter((item) => !item.keep).length
  const actuallyTruncatedTools = decisions.tools.filter((item) => {
    if (item.decision !== "keep_call_truncate_result") return false
    const call = transcript.toolCalls.find((candidate) => candidate.id === item.toolCallId)
    return Boolean(call?.result && call.result.text.length > truncateHeadChars)
  }).length
  stats.semanticReductionActions = stats.textsDropped + stats.toolsDropped + actuallyTruncatedTools
  stats.toolDecisionDiagnostics = diagnostics(transcript, decisions)
}

export async function compactTranscript(
  rawMessages: readonly unknown[],
  asker: JevAsker,
  options: PluginOptions,
  parentSignal?: AbortSignal,
  sessionID?: string,
): Promise<CompactionOutcome> {
  const compactionStarted = performance.now()
  const stats = initialCompactionStats(rawMessages, sessionID)
  if (rawMessages.length === 0 || stats.originalEstimatedTokens === 0) return fallback(stats, "empty-transcript")

  let transcript: ReturnType<typeof normalizeOpenCodeMessages>
  let built: ReturnType<typeof buildJevState>
  let fitted: Extract<ReturnType<typeof fitState>, { ok: true }>
  let plan: ReturnType<typeof buildQuestionPlan>
  let batching: Extract<ReturnType<typeof batchQuestions>, { ok: true }>

  try {
    transcript = normalizeOpenCodeMessages(rawMessages, options.preserveRecentMessages)
    stats.semanticPayloadCharsBefore = semanticPayloadChars(transcript)
    stats.semanticPayloadCharsAfter = stats.semanticPayloadCharsBefore
    built = buildJevState(transcript, { toolResultPreviewChars: options.toolResultPreviewChars })
    stats.redactions = built.redactions
    if (!built.objective) return fallback(stats, "weak-objective-unresolved")

    const capacity = prunablePayloadCapacity(
      transcript,
      options.truncateHeadChars,
      options.minReductionRatio,
    )
    stats.maxPrunablePayloadChars = capacity.removableChars
    stats.maxPrunableFraction = capacity.removableFraction
    stats.eligiblePrunableTools = capacity.eligibleTools
    if (capacity.eligibleTools === 0) return fallback(stats, "nothing-prunable")
    if (!capacity.sufficient) return fallback(stats, "insufficient-prunable-payload")

    const fit = fitState(built.state, { maxStateChars: options.maxStateChars, maxStateTokens: options.maxStateTokens })
    stats.fittedStateChars = fit.chars
    stats.fittedStateEstimatedTokens = fit.tokens
    stats.fitStage = fit.stage
    if (!fit.ok) return fallback(stats, fit.reason)
    fitted = fit

    plan = buildQuestionPlan(fitted.state, transcript, built.constraints, built.files, {
      truncateHeadChars: options.truncateHeadChars,
    })
    stats.toolsScored = plan.tools.size
    stats.textsScored = 0
    if (plan.tools.size === 0) return fallback(stats, "nothing-prunable")

    const batches = batchQuestions(fitted.state, plan.questions, options.maxRequestTokens)
    if (!batches.ok) return fallback(stats, batches.reason)
    batching = batches
  } catch (error) {
    return internalError(stats, error)
  }

  const remainingMs = options.timeoutMs - (performance.now() - compactionStarted)
  if (remainingMs <= 0) return fallback(stats, "compaction-timeout")
  const scope = linkedAbort(parentSignal, Math.max(1, Math.floor(remainingMs)))

  try {
    const jevStarted = performance.now()
    const state = toJson(fitted.state)
    const results = await askBatches(
      batching.batches,
      state,
      asker,
      scope.signal,
      options.maxConcurrentRequests,
    )

    const answers: Record<string, JevAnswer> = {}
    for (const result of results) {
      mergeAnswers(answers, result.response.answers)
      stats.jevRequests += 1
      stats.jevInputTokens += result.response.usage.input_tokens
      stats.jevOutputTokens += result.response.usage.output_tokens
    }
    if (Object.keys(answers).length !== Object.keys(plan.questions).length) return fallback(stats, "missing-jev-answers")

    stats.jevLatencyMs = Math.round(performance.now() - jevStarted)
    stats.estimatedJevCostUsd = stats.jevInputTokens / 1_000_000 * options.jevInputCostPerMillionUsd

    const decisions = composeDecisions(
      transcript,
      fitted.state,
      built.objective,
      built.constraints,
      built.files,
      plan,
      answers,
      { keepThreshold: options.keepThreshold },
    )

    applyDecisionStats(stats, transcript, decisions, options.truncateHeadChars)
    const semantic = semanticPayloadReduction(
      transcript,
      decisions,
      options.truncateHeadChars,
      options.minReductionRatio,
    )
    stats.semanticPayloadCharsBefore = semantic.beforeChars
    stats.semanticPayloadCharsAfter = semantic.afterChars
    stats.semanticRemovedFraction = semantic.removedFraction

    if (stats.semanticReductionActions === 0) return fallback(stats, "no-semantic-reduction")
    if (!semantic.sufficient) return fallback(stats, "insufficient-semantic-reduction")

    const summary = assembleCheckpoint(transcript, built.constraints, built.files, decisions, {
      truncateHeadChars: options.truncateHeadChars,
    })
    stats.checkpointEstimatedTokens = estimateTokens(summary)

    // Serialized reduction remains diagnostic only. It never authorizes success.
    const serialized = reductionGate(stats.originalEstimatedTokens, stats.checkpointEstimatedTokens, 0)
    stats.removedFraction = serialized.removedFraction
    stats.remainingRatio = serialized.remainingRatio

    return { status: "ok", checkpoint: { summary, stats }, decisions }
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError"
      ? "jev-aborted"
      : error instanceof Error
        ? `jev-${error.name}`
        : "jev-error"
    return fallback(stats, reason)
  } finally {
    scope.cleanup()
  }
}
