import type { JsonValue } from "../domain/types.js"

export interface NoulQuestion {
  type: "noul"
  instructions: string
  criteria: { true: string; false: string }
}

export interface ChoiceQuestion {
  type: "choice"
  instructions: string
  criteria: Record<string, string>
}

export interface ScoreQuestion {
  type: "score"
  instructions: string
  criteria: string[]
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

export interface JevRequest {
  model: string
  state: JsonValue
  questions: Record<string, JevQuestion>
}

export interface NoulAnswer {
  type: "noul"
  noul: number
}

export interface ChoiceAnswer {
  type: "choice"
  choice: string
  confidence: number
  probabilities: Record<string, number>
}

export interface ScoreAnswer {
  type: "score"
  score: number
  confidence: number
  probabilities: Record<string, number>
  legend: Record<string, string>
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

export interface JevResponse {
  model: string
  answers: Record<string, JevAnswer>
  usage: {
    input_tokens: number
    output_tokens: number
  }
}

export interface JevBatchResult {
  response: JevResponse
  latencyMs: number
}
