import type {
  ConstraintCandidate,
  FileCandidate,
  NormalizedTranscript,
} from "../domain/types.js"
import { classifyTool, type ToolRetentionPolicy } from "../policy/tool-policy.js"
import type { JevState } from "../state/build.js"
import type { JevQuestion, NoulQuestion } from "./types.js"

export interface ToolQuestionIds {
  policy: Exclude<ToolRetentionPolicy, "pin_full">
  keepCall?: string
  keepResult: string
}

export interface QuestionPlanOptions {
  truncateHeadChars?: number
}

export interface QuestionPlan {
  questions: Record<string, JevQuestion>
  tools: Map<string, ToolQuestionIds>
  /** Kept for adapter compatibility. Text/files/constraints are preserved deterministically. */
  texts: Map<string, never>
  constraints: Map<string, never>
  files: Map<string, never>
}

function noul(instructions: string, yes: string, no: string): NoulQuestion {
  return { type: "noul", instructions, criteria: { true: yes, false: no } }
}

/**
 * One Jev decision pass. Application policy determines what may be destroyed:
 *
 * - pin_full tools receive no question.
 * - protect_call tools ask only whether the full result must remain.
 * - drop_eligible tools ask independent keep-call and keep-result questions.
 *
 * All questions share the same chronological state and are batched only when
 * the request budget requires it.
 */
export function buildQuestionPlan(
  _state: JevState,
  transcript: NormalizedTranscript,
  _constraints: ConstraintCandidate[],
  _files: FileCandidate[],
  options: QuestionPlanOptions = {},
): QuestionPlan {
  const questions: Record<string, JevQuestion> = {}
  const tools = new Map<string, ToolQuestionIds>()

  let index = 0
  for (const call of transcript.toolCalls) {
    const policy = classifyTool(call)
    if (policy === "pin_full") continue
    if (
      policy === "protect_call" &&
      (call.result?.text.length ?? 0) <= Math.max(0, options.truncateHeadChars ?? 0)
    ) continue

    const prefix = `tool_${index++}`
    const keepResult = `${prefix}_keep_result`
    const ids: ToolQuestionIds = { policy, keepResult }

    if (policy === "drop_eligible") {
      ids.keepCall = `${prefix}_keep_call`
      questions[ids.keepCall] = noul(
        `For the current objective in state.goal, should history retain that tool call ${call.id} (${call.toolName}) happened, including its input, because losing that provenance would impair correct continuation or cause meaningful repeated work?`,
        "The call/input is still necessary for the current objective, an applicable decision or constraint, completed-work provenance, or avoiding meaningful repeated work.",
        "Knowing this call happened is no longer necessary for correct continuation; if needed, this cheap read-only operation can be repeated.",
      )
    }

    questions[keepResult] = noul(
      `For the current objective in state.goal, does the exact full output of tool call ${call.id} (${call.toolName}) still need to remain available verbatim, rather than keeping a short exact prefix and rerunning/re-reading the tool if needed?`,
      "Exact result content is still necessary, including precise unresolved evidence, identifiers, values, or content that cannot safely be recovered for the current objective.",
      "The exact full result is no longer necessary; a short retained prefix or repeating the operation would be sufficient if the content becomes needed again.",
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
