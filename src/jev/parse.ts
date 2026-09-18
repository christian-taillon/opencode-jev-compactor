import type { JevAnswer, JevQuestion, JevResponse } from "./types.js"

export class JevMalformedResponseError extends Error {
  override readonly name = "JevMalformedResponseError"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finite01(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new JevMalformedResponseError(`${label} must be a number from 0 to 1`)
  }
  return value
}

function finiteNonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new JevMalformedResponseError(`${label} must be a non-negative number`)
  }
  return value
}

function parseChoiceProbabilities(value: unknown, allowed: Set<string>, id: string): Record<string, number> {
  if (!isRecord(value)) throw new JevMalformedResponseError(`${id}.probabilities must be an object`)
  const out: Record<string, number> = {}
  for (const key of allowed) {
    if (!(key in value)) throw new JevMalformedResponseError(`${id}.probabilities is missing option ${key}`)
    out[key] = finite01(value[key], `${id}.probabilities.${key}`)
  }
  return out
}

function parseAnswer(raw: unknown, question: JevQuestion, id: string): JevAnswer {
  if (!isRecord(raw)) throw new JevMalformedResponseError(`answer ${id} must be an object`)
  if (raw.type !== question.type) throw new JevMalformedResponseError(`${id}.type does not match its question`)

  if (question.type === "noul") {
    return { type: "noul", noul: finite01(raw.noul, `${id}.noul`) }
  }

  if (question.type === "choice") {
    if (typeof raw.choice !== "string" || !(raw.choice in question.criteria)) {
      throw new JevMalformedResponseError(`${id}.choice is invalid`)
    }
    return {
      type: "choice",
      choice: raw.choice,
      confidence: finite01(raw.confidence, `${id}.confidence`),
      probabilities: parseChoiceProbabilities(raw.probabilities, new Set(Object.keys(question.criteria)), id),
    }
  }

  const maxScore = Math.max(0, question.criteria.length - 1)
  const score = finiteNonNegative(raw.score, `${id}.score`)
  if (score > maxScore) throw new JevMalformedResponseError(`${id}.score exceeds score legend`)
  const confidence = finite01(raw.confidence, `${id}.confidence`)
  if (!isRecord(raw.probabilities)) throw new JevMalformedResponseError(`${id}.probabilities must be an object`)
  if (!isRecord(raw.legend)) throw new JevMalformedResponseError(`${id}.legend must be an object`)

  const probabilities: Record<string, number> = {}
  const legend: Record<string, string> = {}
  for (let index = 0; index < question.criteria.length; index += 1) {
    const key = String(index)
    if (!(key in raw.probabilities)) throw new JevMalformedResponseError(`${id}.probabilities is missing level ${key}`)
    probabilities[key] = finite01(raw.probabilities[key], `${id}.probabilities.${key}`)
    const label = raw.legend[key]
    if (typeof label !== "string") throw new JevMalformedResponseError(`${id}.legend is missing level ${key}`)
    legend[key] = label
  }
  return { type: "score", score, confidence, probabilities, legend }
}

export function parseJevResponse(raw: unknown, expected: Record<string, JevQuestion>): JevResponse {
  if (!isRecord(raw)) throw new JevMalformedResponseError("Jev response must be an object")
  if (typeof raw.model !== "string" || raw.model.length === 0) throw new JevMalformedResponseError("Jev response.model must be a non-empty string")
  if (!isRecord(raw.answers)) throw new JevMalformedResponseError("Jev response.answers must be an object")
  if (!isRecord(raw.usage)) throw new JevMalformedResponseError("Jev response.usage must be an object")

  const answers: Record<string, JevAnswer> = {}
  for (const [id, question] of Object.entries(expected)) {
    if (!(id in raw.answers)) throw new JevMalformedResponseError(`missing answer ${id}`)
    answers[id] = parseAnswer(raw.answers[id], question, id)
  }
  return {
    model: raw.model,
    answers,
    usage: {
      input_tokens: finiteNonNegative(raw.usage.input_tokens, "usage.input_tokens"),
      output_tokens: finiteNonNegative(raw.usage.output_tokens, "usage.output_tokens"),
    },
  }
}
