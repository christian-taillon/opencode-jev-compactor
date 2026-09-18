import type { JevState } from "../state/build.js"
import { estimateJsonTokens } from "../state/estimate.js"
import type { JevQuestion } from "./types.js"

export interface QuestionBatch {
  questions: Record<string, JevQuestion>
  estimatedTokens: number
}

export type BatchPlan =
  | { ok: true; batches: QuestionBatch[] }
  | { ok: false; reason: "question-exceeds-context" | "question-exceeds-request-budget" | "state-exceeds-request-budget" }

export function batchQuestions(state: JevState, questions: Record<string, JevQuestion>, maxRequestTokens: number): BatchPlan {
  const stateTokens = estimateJsonTokens(state)
  if (stateTokens >= maxRequestTokens) return { ok: false, reason: "state-exceeds-request-budget" }

  const batches: QuestionBatch[] = []
  let current: Record<string, JevQuestion> = {}
  let currentTokens = stateTokens
  for (const [id, question] of Object.entries(questions)) {
    const questionTokens = estimateJsonTokens({ [id]: question })
    if (stateTokens + questionTokens > 31_500) return { ok: false, reason: "question-exceeds-context" }
    if (stateTokens + questionTokens > maxRequestTokens) return { ok: false, reason: "question-exceeds-request-budget" }
    if (currentTokens + questionTokens > maxRequestTokens && Object.keys(current).length > 0) {
      batches.push({ questions: current, estimatedTokens: currentTokens })
      current = {}
      currentTokens = stateTokens
    }
    current[id] = question
    currentTokens += questionTokens
  }
  if (Object.keys(current).length > 0) batches.push({ questions: current, estimatedTokens: currentTokens })
  return { ok: true, batches }
}
