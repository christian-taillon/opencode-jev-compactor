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
}

function answer(
  answers: Record<string, JevAnswer>,
  id: string,
): Extract<JevAnswer, { type: "noul" }> {
  const value = answers[id]
  if (!value || value.type !== "noul") throw new Error(`Missing or invalid Jev answer: ${id}`)
  return value
}

function composeTool(
  callId: string,
  plan: QuestionPlan,
  answers: Record<string, JevAnswer>,
  options: ComposeOptions,
): ToolDecision {
  const ids = plan.tools.get(callId)
  if (!ids) return { toolCallId: callId, decision: "keep_full", reason: "policy" }

  const keepResult = answer(answers, ids.keepResult).noul
  const keepCall = ids.keepCall ? answer(answers, ids.keepCall).noul : undefined
  const signals: ToolSignals = {
    keepResult,
    ...(keepCall !== undefined ? { keepCall } : {}),
  }

  // Equality keeps. Destructive actions require a probability below threshold.
  if (keepResult >= options.keepThreshold) {
    return { toolCallId: callId, decision: "keep_full", reason: "jev", signals }
  }

  // Application policy has already decided provenance for this tool class stays.
  if (ids.policy === "protect_call") {
    return { toolCallId: callId, decision: "keep_call_truncate_result", reason: "jev", signals }
  }

  if (keepCall === undefined) {
    return { toolCallId: callId, decision: "keep_full", reason: "policy", signals }
  }
  if (keepCall >= options.keepThreshold) {
    return { toolCallId: callId, decision: "keep_call_truncate_result", reason: "jev", signals }
  }
  return { toolCallId: callId, decision: "drop", reason: "jev", signals }
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
): CompactionDecisions {
  const tools = transcript.toolCalls.map((call) => composeTool(
    call.id,
    plan,
    answers,
    options,
  ))

  // Conversational intent, constraints, and course corrections stay verbatim.
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
