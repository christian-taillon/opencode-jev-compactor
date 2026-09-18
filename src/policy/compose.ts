import type {
  CompactionDecisions,
  ConstraintCandidate,
  ConstraintDecision,
  FileCandidate,
  FileDecision,
  NormalizedTranscript,
  ResolvedObjective,
  TextDecision,
  ToolDecision,
  ToolSignals,
} from "../domain/types.js"
import type { QuestionPlan } from "../jev/questions.js"
import type { JevAnswer } from "../jev/types.js"
import type { JevState } from "../state/build.js"

export interface ComposeOptions {
  keepThreshold: number
  verificationThreshold: number
  uncertaintyMargin: number
}

function answer(
  answers: Record<string, JevAnswer>,
  id: string,
): Extract<JevAnswer, { type: "noul" }> {
  const value = answers[id]
  if (!value || value.type !== "noul") throw new Error(`Missing or invalid Jev answer: ${id}`)
  return value
}

function uncertain(probability: number, margin: number): boolean {
  return Math.abs(probability - 0.5) < margin
}

function composeTool(
  callId: string,
  pinned: boolean,
  plan: QuestionPlan,
  answers: Record<string, JevAnswer>,
  options: ComposeOptions,
  verification: ReadonlyMap<string, number>,
): ToolDecision {
  if (pinned) return { toolCallId: callId, decision: "keep_full", reason: "pinned" }
  const ids = plan.tools.get(callId)
  if (!ids) return { toolCallId: callId, decision: "keep_full", reason: "uncertain" }

  const keepCall = answer(answers, ids.keepCall).noul
  const keepResult = answer(answers, ids.keepResult).noul
  const verify = verification.get(callId)
  const signals: ToolSignals = {
    keepCall,
    keepResult,
    ...(verify !== undefined ? { verification: verify } : {}),
  }

  // Exact-result uncertainty always fails toward full retention.
  if (uncertain(keepResult, options.uncertaintyMargin) || keepResult >= options.keepThreshold) {
    return { toolCallId: callId, decision: "keep_full", reason: uncertain(keepResult, options.uncertaintyMargin) ? "uncertain" : "jev", signals }
  }
  if (uncertain(keepCall, options.uncertaintyMargin)) {
    return { toolCallId: callId, decision: "keep_full", reason: "uncertain", signals }
  }

  const proposed = keepCall >= options.keepThreshold ? "keep_call_truncate_result" : "drop"
  // A first-pass proposal is intentionally provisional. Engine code verifies every
  // destructive action with richer candidate evidence before installing it.
  if (verify === undefined) return { toolCallId: callId, decision: proposed, reason: "jev", signals }

  if (uncertain(verify, options.uncertaintyMargin) || verify < options.verificationThreshold) {
    return { toolCallId: callId, decision: "keep_full", reason: "uncertain", signals }
  }
  return { toolCallId: callId, decision: proposed, reason: "jev", signals }
}

export function composeDecisions(
  transcript: NormalizedTranscript,
  _state: JevState,
  objective: ResolvedObjective,
  constraints: ConstraintCandidate[],
  files: FileCandidate[],
  plan: QuestionPlan,
  answers: Record<string, JevAnswer>,
  options: ComposeOptions,
  verification: ReadonlyMap<string, number> = new Map(),
): CompactionDecisions {
  const tools = transcript.toolCalls.map((call) => composeTool(
    call.id,
    call.pinned || call.result?.pinned === true,
    plan,
    answers,
    options,
    verification,
  ))

  // 0.0.5 preserves user/assistant text by default. Jev prunes high-volume tool
  // traces while exact conversational intent, constraints, and course corrections
  // remain verbatim.
  const texts: TextDecision[] = transcript.textBlocks
    .filter((block) => block.checkpointEligible)
    .map((block) => ({
      textId: block.id,
      keep: true,
      category: block.id === objective.textId ? "objective" : "evidence",
      reason: block.pinned ? "pinned" : block.source === "unknown-part" ? "unknown-part" : "jev",
    }))

  const constraintDecisions: ConstraintDecision[] = constraints.map((candidate) => ({
    id: candidate.id,
    keep: true,
    probability: 1,
  }))
  const fileDecisions: FileDecision[] = files.map((candidate) => ({
    id: candidate.id,
    keep: true,
    probability: 1,
  }))

  return {
    objectiveText: objective.text,
    ...(objective.textId ? { objectiveTextId: objective.textId } : {}),
    tools,
    texts,
    constraints: constraintDecisions,
    files: fileDecisions,
  }
}
