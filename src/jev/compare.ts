import type { JevAsker } from "../compaction/engine.js"
import type { JsonValue } from "../domain/types.js"
import { redactSecrets } from "../state/redact.js"
import type { JevQuestion } from "./types.js"

export interface CompareInput {
  left: string
  right: string
  criterion: string
  context?: string
}

export interface CompareResult {
  choice: "left" | "right" | "tie"
  confidence: number
  leftScore: number
  leftConfidence: number
  rightScore: number
  rightConfidence: number
  redactions: number
}

export async function compareWithJev(asker: JevAsker, input: CompareInput, signal?: AbortSignal): Promise<CompareResult> {
  let redactions = 0
  const redact = (value: string): string => {
    const result = redactSecrets(value)
    redactions += result.count
    return result.text
  }
  const state = {
    criterion: redact(input.criterion),
    context: redact(input.context ?? ""),
    left: redact(input.left),
    right: redact(input.right),
  }
  const levels = [
    "0: not relevant to the criterion",
    "1: weakly relevant",
    "2: moderately relevant",
    "3: strongly relevant",
    "4: directly satisfies or is maximally relevant to the criterion",
  ]
  const questions: Record<string, JevQuestion> = {
    comparison: {
      type: "choice",
      instructions: "Which of `left` or `right` better satisfies `criterion` in `context`? Choose tie when neither has a material advantage.",
      criteria: {
        left: "`left` better satisfies the criterion.",
        right: "`right` better satisfies the criterion.",
        tie: "They satisfy the criterion about equally, or state is insufficient to distinguish them.",
      },
    },
    left_relevance: { type: "score", instructions: "Score how well `left` satisfies `criterion` in `context`.", criteria: levels },
    right_relevance: { type: "score", instructions: "Score how well `right` satisfies `criterion` in `context`.", criteria: levels },
  }
  const result = await asker.ask(state as unknown as JsonValue, questions, signal)
  const comparison = result.response.answers.comparison
  const left = result.response.answers.left_relevance
  const right = result.response.answers.right_relevance
  if (!comparison || comparison.type !== "choice" || !left || left.type !== "score" || !right || right.type !== "score") {
    throw new Error("Malformed Jev comparison response")
  }
  return {
    choice: comparison.choice as "left" | "right" | "tie",
    confidence: comparison.confidence,
    leftScore: left.score,
    leftConfidence: left.confidence,
    rightScore: right.score,
    rightConfidence: right.confidence,
    redactions,
  }
}
