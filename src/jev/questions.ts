import type {
  ConstraintCandidate,
  FileCandidate,
  NormalizedTranscript,
  ToolDecisionKind,
} from "../domain/types.js"
import type { JevState } from "../state/build.js"
import type { JevQuestion, NoulQuestion } from "./types.js"

export interface ToolQuestionIds {
  keepCall: string
  keepResult: string
}

export interface QuestionPlan {
  questions: Record<string, JevQuestion>
  tools: Map<string, ToolQuestionIds>
  /** Kept for adapter compatibility. Text/files/constraints are preserved deterministically in 0.0.5. */
  texts: Map<string, never>
  constraints: Map<string, never>
  files: Map<string, never>
}

function noul(instructions: string, yes: string, no: string): NoulQuestion {
  return { type: "noul", instructions, criteria: { true: yes, false: no } }
}

/**
 * First pass: two independent judgments per tool. Text is not scored for deletion.
 * The state already carries chronology, goal, previous checkpoint baseline, call input,
 * result status/size, and a small result preview.
 */
export function buildQuestionPlan(
  _state: JevState,
  transcript: NormalizedTranscript,
  _constraints: ConstraintCandidate[],
  _files: FileCandidate[],
): QuestionPlan {
  const questions: Record<string, JevQuestion> = {}
  const tools = new Map<string, ToolQuestionIds>()

  let index = 0
  for (const call of transcript.toolCalls) {
    if (call.pinned || call.result?.pinned === true || !call.result) continue
    const prefix = `tool_${index++}`
    const ids = {
      keepCall: `${prefix}_keep_call`,
      keepResult: `${prefix}_keep_result`,
    }
    questions[ids.keepCall] = noul(
      `Should the history retain that tool call ${call.id} (${call.toolName}) happened, including its input, because losing that provenance could impair the current objective or cause meaningful repeated work?`,
      "The fact/input of this call remains useful for continuation, completed-work memory, provenance, or avoiding repeated work.",
      "Knowing this call happened no longer has meaningful value for correct continuation.",
    )
    questions[ids.keepResult] = noul(
      `Does the exact full output of tool call ${call.id} (${call.toolName}) still need to remain available verbatim for correct continuation, rather than being truncated or recovered by rerunning/re-reading if needed?`,
      "Exact result content is still needed, including precise evidence, unresolved diagnostics, values, identifiers, or output that cannot safely be discarded.",
      "The exact full result is no longer needed; a short retained prefix or rerunning/re-reading the tool would be sufficient if needed.",
    )
    tools.set(call.id, ids)
  }

  return {
    questions,
    tools,
    texts: new Map<string, never>(),
    constraints: new Map<string, never>(),
    files: new Map<string, never>(),
  }
}

export function verificationQuestion(
  toolCallId: string,
  toolName: string,
  proposed: Exclude<ToolDecisionKind, "keep_full">,
): NoulQuestion {
  const action = proposed === "drop"
    ? "drop both the tool call and its result"
    : "keep the tool call but truncate its result to a short exact prefix"
  return noul(
    `Given the richer candidate evidence in candidateTool, is it safe to ${action} for tool call ${toolCallId} (${toolName}) without losing information needed to continue correctly, hiding an unresolved blocker, forgetting completed work, or causing meaningful repeated work?`,
    "The proposed destructive action is safe; the remaining history is sufficient for correct continuation.",
    "The proposed action risks losing useful context; retain the complete tool call and result instead.",
  )
}
