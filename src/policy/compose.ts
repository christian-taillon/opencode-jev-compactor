import type {
  CompactionDecisions,
  ConstraintCandidate,
  ConstraintDecision,
  FileCandidate,
  FileDecision,
  MessageCategory,
  NormalizedTranscript,
  ResolvedObjective,
  TextDecision,
  TextSignals,
  ToolDecision,
  ToolDecisionKind,
  ToolSignals,
} from "../domain/types.js"
import type { QuestionPlan } from "../jev/questions.js"
import type { JevAnswer, ScoreAnswer } from "../jev/types.js"
import type { JevState } from "../state/build.js"

export interface ComposeOptions {
  keepThreshold: number
  exactEvidenceThreshold: number
  discardThreshold: number
  supersededThreshold: number
  uncertaintyMargin: number
  minConfidence: number
}

function answer<T extends JevAnswer["type"]>(
  answers: Record<string, JevAnswer>,
  id: string,
  type: T,
): Extract<JevAnswer, { type: T }> {
  const value = answers[id]
  if (!value || value.type !== type) throw new Error(`Missing or invalid Jev answer: ${id}`)
  return value as Extract<JevAnswer, { type: T }>
}

function uncertainProbability(probability: number, margin: number): boolean {
  return Math.abs(probability - 0.5) < margin
}

function normalizedScore(value: ScoreAnswer): number {
  return Math.max(0, Math.min(1, value.score / 4))
}

function composeTool(
  callId: string,
  pinned: boolean,
  plan: QuestionPlan,
  answers: Record<string, JevAnswer>,
  options: ComposeOptions,
): ToolDecision {
  if (pinned) return { toolCallId: callId, decision: "keep_full", reason: "pinned" }
  const ids = plan.tools.get(callId)
  if (!ids) return { toolCallId: callId, decision: "keep_full", reason: "uncertain" }

  const keepCall = answer(answers, ids.keepCall, "noul").noul
  const exactEvidence = answer(answers, ids.exactEvidence, "noul").noul
  const unresolvedBlocker = answer(answers, ids.unresolvedBlocker, "noul").noul
  const completedWork = answer(answers, ids.completedWork, "noul").noul
  const repeatWorkRisk = answer(answers, ids.repeatWorkRisk, "noul").noul
  const superseded = answer(answers, ids.superseded, "noul").noul
  const truncateSafe = answer(answers, ids.truncateSafe, "noul").noul
  const safeToDiscard = answer(answers, ids.safeToDiscard, "noul").noul
  const relevanceAnswer = answer(answers, ids.relevance, "score")
  const actionAnswer = answer(answers, ids.action, "choice")
  const relevance = normalizedScore(relevanceAnswer)
  const signals: ToolSignals = {
    keepCall,
    exactEvidence,
    unresolvedBlocker,
    completedWork,
    repeatWorkRisk,
    superseded,
    truncateSafe,
    safeToDiscard,
    relevance,
    relevanceConfidence: relevanceAnswer.confidence,
    choice: actionAnswer.choice as ToolDecisionKind,
    choiceConfidence: actionAnswer.confidence,
    choiceProbabilities: actionAnswer.probabilities,
  }

  const fullChoice = actionAnswer.probabilities.keep_full ?? 0
  const truncateChoice = actionAnswer.probabilities.keep_call_truncate_result ?? 0
  const dropChoice = actionAnswer.probabilities.drop ?? 0

  // Exact evidence and unresolved blockers get the strongest protection.
  if (
    uncertainProbability(exactEvidence, options.uncertaintyMargin) ||
    uncertainProbability(unresolvedBlocker, options.uncertaintyMargin)
  ) {
    return { toolCallId: callId, decision: "keep_full", reason: "uncertain", signals }
  }
  if (
    exactEvidence >= options.exactEvidenceThreshold ||
    unresolvedBlocker >= options.keepThreshold ||
    fullChoice >= options.keepThreshold
  ) {
    return { toolCallId: callId, decision: "keep_full", reason: "jev", signals }
  }

  // Weak Jev confidence never authorizes deletion.
  if (relevanceAnswer.confidence < options.minConfidence || actionAnswer.confidence < options.minConfidence) {
    const decision = truncateSafe >= options.keepThreshold ? "keep_call_truncate_result" : "keep_full"
    return { toolCallId: callId, decision, reason: "uncertain", signals }
  }

  const preservationSignal = Math.max(keepCall, completedWork, repeatWorkRisk, relevance, fullChoice, truncateChoice)
  if (
    uncertainProbability(keepCall, options.uncertaintyMargin) ||
    uncertainProbability(completedWork, options.uncertaintyMargin) ||
    uncertainProbability(repeatWorkRisk, options.uncertaintyMargin) ||
    uncertainProbability(truncateSafe, options.uncertaintyMargin) ||
    preservationSignal >= options.keepThreshold
  ) {
    const decision = truncateSafe >= options.keepThreshold && !uncertainProbability(truncateSafe, options.uncertaintyMargin)
      ? "keep_call_truncate_result"
      : "keep_full"
    return {
      toolCallId: callId,
      decision,
      reason: preservationSignal >= options.keepThreshold ? "jev" : "uncertain",
      signals,
    }
  }

  // Deletion requires affirmative evidence that the whole item is disposable, not merely a low keep score.
  const disposalProven =
    safeToDiscard >= options.discardThreshold &&
    dropChoice >= options.discardThreshold &&
    exactEvidence < options.exactEvidenceThreshold &&
    unresolvedBlocker < options.keepThreshold &&
    completedWork < options.keepThreshold &&
    repeatWorkRisk < options.keepThreshold &&
    keepCall < options.keepThreshold &&
    relevance < options.keepThreshold &&
    truncateSafe >= options.keepThreshold &&
    (superseded >= options.supersededThreshold || relevance <= 0.25)

  if (disposalProven) return { toolCallId: callId, decision: "drop", reason: "jev", signals }

  // If Jev cannot prove disposal, keep at least provenance plus an exact result prefix.
  return {
    toolCallId: callId,
    decision: truncateSafe >= options.keepThreshold ? "keep_call_truncate_result" : "keep_full",
    reason: "uncertain",
    signals,
  }
}

function composeText(
  textId: string,
  transcript: NormalizedTranscript,
  plan: QuestionPlan,
  answers: Record<string, JevAnswer>,
  options: ComposeOptions,
): TextDecision {
  const block = transcript.textBlocks.find((item) => item.id === textId)
  if (!block) throw new Error(`Unknown text block: ${textId}`)
  if (block.messageId === transcript.newestUserMessageId) {
    return { textId, keep: true, category: "objective", reason: "newest-user" }
  }
  if (block.source === "unknown-part") {
    return { textId, keep: true, category: "evidence", reason: "unknown-part" }
  }
  if (block.pinned) {
    return { textId, keep: true, category: block.role === "user" ? "objective" : "active", reason: "pinned" }
  }

  const ids = plan.texts.get(textId)
  if (!ids) return { textId, keep: true, category: "evidence", reason: "uncertain" }
  const keep = answer(answers, ids.keep, "noul").noul
  const safeToDiscard = answer(answers, ids.safeToDiscard, "noul").noul
  const superseded = answer(answers, ids.superseded, "noul").noul
  const relevanceAnswer = answer(answers, ids.relevance, "score")
  const categoryAnswer = answer(answers, ids.category, "choice")
  const relevance = normalizedScore(relevanceAnswer)
  const category = categoryAnswer.choice as MessageCategory
  const signals: TextSignals = {
    keep,
    safeToDiscard,
    superseded,
    relevance,
    relevanceConfidence: relevanceAnswer.confidence,
    category,
    categoryConfidence: categoryAnswer.confidence,
    categoryProbabilities: categoryAnswer.probabilities,
  }

  if (
    uncertainProbability(keep, options.uncertaintyMargin) ||
    uncertainProbability(safeToDiscard, options.uncertaintyMargin) ||
    relevanceAnswer.confidence < options.minConfidence ||
    categoryAnswer.confidence < options.minConfidence
  ) {
    return {
      textId,
      keep: true,
      category: category === "irrelevant" ? "evidence" : category,
      reason: "uncertain",
      signals,
    }
  }

  const disposalProven =
    safeToDiscard >= options.discardThreshold &&
    keep < options.keepThreshold &&
    relevance < options.keepThreshold &&
    category === "irrelevant" &&
    (superseded >= options.supersededThreshold || relevance <= 0.25)

  return {
    textId,
    keep: !disposalProven,
    category: disposalProven ? category : (category === "irrelevant" ? "evidence" : category),
    reason: "jev",
    signals,
  }
}

function composeCandidate(
  questionId: string | undefined,
  answers: Record<string, JevAnswer>,
  options: ComposeOptions,
): { keep: boolean; probability: number } {
  if (!questionId) return { keep: true, probability: 0.5 }
  const probability = answer(answers, questionId, "noul").noul
  return {
    keep: uncertainProbability(probability, options.uncertaintyMargin) || probability >= options.keepThreshold,
    probability,
  }
}

export function composeDecisions(
  transcript: NormalizedTranscript,
  state: JevState,
  objective: ResolvedObjective,
  constraints: ConstraintCandidate[],
  files: FileCandidate[],
  plan: QuestionPlan,
  answers: Record<string, JevAnswer>,
  options: ComposeOptions,
): CompactionDecisions {
  const tools = transcript.toolCalls.map((call) => composeTool(
    call.id,
    call.pinned || call.result?.pinned === true,
    plan,
    answers,
    options,
  ))
  const constraintDecisions: ConstraintDecision[] = constraints.map((candidate) => ({
    id: candidate.id,
    ...composeCandidate(plan.constraints.get(candidate.id), answers, options),
  }))
  const fileDecisions: FileDecision[] = files.map((candidate) => ({
    id: candidate.id,
    ...composeCandidate(plan.files.get(candidate.id), answers, options),
  }))
  const objectiveTextId = objective.textId

  const requiredTextIds = new Map<string, MessageCategory>()
  if (objectiveTextId) requiredTextIds.set(objectiveTextId, "objective")
  const keptConstraintIds = new Set(constraintDecisions.filter((item) => item.keep).map((item) => item.id))
  for (const candidate of constraints) {
    if (keptConstraintIds.has(candidate.id)) requiredTextIds.set(candidate.sourceTextId, "constraint")
  }

  const texts = transcript.textBlocks.filter((block) => block.checkpointEligible).map((block) => {
    const decision = composeText(block.id, transcript, plan, answers, options)
    const forcedCategory = requiredTextIds.get(block.id)
    if (!forcedCategory || decision.keep) return decision
    return { ...decision, keep: true, category: forcedCategory, reason: "retained-fact" as const }
  })

  return {
    objectiveText: objective.text,
    ...(objectiveTextId ? { objectiveTextId } : {}),
    tools,
    texts,
    constraints: constraintDecisions,
    files: fileDecisions,
  }
}
