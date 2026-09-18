import type { CompactionOutcome, CompactionStats, JsonValue } from "../domain/types.js"
import { batchQuestions } from "../jev/batch.js"
import { buildQuestionPlan } from "../jev/questions.js"
import type { JevAnswer, JevBatchResult, JevQuestion } from "../jev/types.js"
import type { PluginOptions } from "../plugin/options.js"
import { composeDecisions } from "../policy/compose.js"
import { reductionGate } from "../policy/reduction.js"
import { buildJevState } from "../state/build.js"
import { estimateJsonTokens, estimateTokens } from "../state/estimate.js"
import { fitState } from "../state/fit.js"
import { assembleCheckpoint } from "../transcript/checkpoint.js"
import { normalizeOpenCodeMessages } from "../transcript/normalize.js"

export interface JevAsker {
  ask(state: JsonValue, questions: Record<string, JevQuestion>, signal?: AbortSignal): Promise<JevBatchResult>
}

export function initialCompactionStats(rawMessages: readonly unknown[]): CompactionStats {
  return {
    originalEstimatedTokens: estimateJsonTokens(rawMessages),
    checkpointEstimatedTokens: 0,
    removedFraction: 0,
    remainingRatio: 1,
    fittedStateEstimatedTokens: 0,
    fittedStateChars: 0,
    fitStage: "none",
    jevRequests: 0,
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

export async function compactTranscript(
  rawMessages: readonly unknown[],
  asker: JevAsker,
  options: PluginOptions,
  parentSignal?: AbortSignal,
): Promise<CompactionOutcome> {
  const compactionStarted = performance.now()
  const stats = initialCompactionStats(rawMessages)
  if (rawMessages.length === 0 || stats.originalEstimatedTokens === 0) return fallback(stats, "empty-transcript")

  let transcript: ReturnType<typeof normalizeOpenCodeMessages>
  let built: ReturnType<typeof buildJevState>
  let fitted: Extract<ReturnType<typeof fitState>, { ok: true }>
  let plan: ReturnType<typeof buildQuestionPlan>
  let batching: Extract<ReturnType<typeof batchQuestions>, { ok: true }>

  try {
    transcript = normalizeOpenCodeMessages(rawMessages, options.preserveRecentMessages)
    built = buildJevState(transcript, { toolResultPreviewChars: options.toolResultPreviewChars })
    stats.redactions = built.redactions
    const fit = fitState(built.state, { maxStateChars: options.maxStateChars, maxStateTokens: options.maxStateTokens })
    stats.fittedStateChars = fit.chars
    stats.fittedStateEstimatedTokens = fit.tokens
    stats.fitStage = fit.stage
    if (!fit.ok) return fallback(stats, fit.reason)
    fitted = fit

    plan = buildQuestionPlan(fitted.state, transcript, built.constraints, built.files)
    stats.toolsScored = plan.tools.size
    stats.textsScored = plan.texts.size
    // If everything that could carry transcript payload is pinned, there is nothing
    // useful for Jev to prune. Objective/file/constraint classification alone should
    // not manufacture a checkpoint for an already-short session.
    if (plan.tools.size === 0 && plan.texts.size === 0) return fallback(stats, "nothing-prunable")
    if (Object.keys(plan.questions).length === 0) return fallback(stats, "nothing-to-score")

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
    const results = await Promise.all(
      batching.batches.map((batch) => asker.ask(fitted.state as unknown as JsonValue, batch.questions, scope.signal)),
    )
    stats.jevLatencyMs = Math.round(performance.now() - jevStarted)
    const answers: Record<string, JevAnswer> = {}
    for (const result of results) {
      mergeAnswers(answers, result.response.answers)
      stats.jevRequests += 1
      stats.jevInputTokens += result.response.usage.input_tokens
      stats.jevOutputTokens += result.response.usage.output_tokens
    }
    stats.estimatedJevCostUsd = stats.jevInputTokens / 1_000_000 * options.jevInputCostPerMillionUsd
    if (Object.keys(answers).length !== Object.keys(plan.questions).length) return fallback(stats, "missing-jev-answers")

    try {
      const decisions = composeDecisions(
        transcript,
        fitted.state,
        built.constraints,
        built.files,
        plan,
        answers,
        {
          keepThreshold: options.keepThreshold,
          exactEvidenceThreshold: options.exactEvidenceThreshold,
          discardThreshold: options.discardThreshold,
          supersededThreshold: options.supersededThreshold,
          uncertaintyMargin: options.uncertaintyMargin,
          minConfidence: options.minConfidence,
        },
      )
      stats.toolsKeptFull = decisions.tools.filter((item) => item.decision === "keep_full").length
      stats.toolsTruncated = decisions.tools.filter((item) => item.decision === "keep_call_truncate_result").length
      stats.toolsDropped = decisions.tools.filter((item) => item.decision === "drop").length
      stats.textsKept = decisions.texts.filter((item) => item.keep).length
      stats.textsDropped = decisions.texts.filter((item) => !item.keep).length

      const summary = assembleCheckpoint(transcript, built.constraints, built.files, decisions, {
        truncateHeadChars: options.truncateHeadChars,
      })
      stats.checkpointEstimatedTokens = estimateTokens(summary)
      const reduction = reductionGate(stats.originalEstimatedTokens, stats.checkpointEstimatedTokens, options.minReductionRatio)
      stats.removedFraction = reduction.removedFraction
      stats.remainingRatio = reduction.remainingRatio
      if (!reduction.sufficient) return fallback(stats, "insufficient-reduction")

      return { status: "ok", checkpoint: { summary, stats }, decisions }
    } catch (error) {
      return internalError(stats, error)
    }
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
