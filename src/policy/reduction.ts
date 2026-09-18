import type { CompactionDecisions, NormalizedTranscript } from "../domain/types.js"

export interface ReductionResult {
  originalTokens: number
  compactedTokens: number
  removedFraction: number
  remainingRatio: number
  sufficient: boolean
}

export interface SemanticPayloadReduction {
  beforeChars: number
  afterChars: number
  removedFraction: number
  sufficient: boolean
}

/** Representation-level diagnostic retained for observability and legacy tests. */
export function reductionGate(originalTokens: number, compactedTokens: number, minReductionRatio: number): ReductionResult {
  if (originalTokens <= 0) {
    return { originalTokens, compactedTokens, removedFraction: 0, remainingRatio: 1, sufficient: false }
  }
  const remainingRatio = compactedTokens / originalTokens
  const removedFraction = Math.max(0, 1 - remainingRatio)
  return {
    originalTokens,
    compactedTokens,
    removedFraction,
    remainingRatio,
    sufficient: removedFraction >= minReductionRatio,
  }
}

/**
 * Measures actual transcript payload retained by policy rather than comparing
 * OpenCode JSON serialization with generated Markdown. This is the acceptance
 * metric used by 0.0.5.
 */
export function semanticPayloadReduction(
  transcript: NormalizedTranscript,
  decisions: CompactionDecisions,
  truncateHeadChars: number,
  minReductionRatio: number,
): SemanticPayloadReduction {
  const textById = new Map(decisions.texts.map((item) => [item.textId, item] as const))
  const toolById = new Map(decisions.tools.map((item) => [item.toolCallId, item] as const))

  let beforeChars = 0
  let afterChars = 0

  for (const block of transcript.textBlocks) {
    if (!block.checkpointEligible) continue
    beforeChars += block.text.length
    if (textById.get(block.id)?.keep !== false) afterChars += block.text.length
  }
  for (const attachment of transcript.attachments) {
    beforeChars += attachment.descriptor.length
    afterChars += attachment.descriptor.length
  }
  for (const call of transcript.toolCalls) {
    const resultChars = call.result?.text.length ?? 0
    beforeChars += call.inputText.length + resultChars
    const decision = toolById.get(call.id)?.decision ?? "keep_full"
    if (decision === "drop") continue
    afterChars += call.inputText.length
    if (decision === "keep_full") afterChars += resultChars
    else afterChars += Math.min(resultChars, Math.max(0, truncateHeadChars))
  }

  const removedFraction = beforeChars === 0 ? 0 : Math.max(0, 1 - afterChars / beforeChars)
  return {
    beforeChars,
    afterChars,
    removedFraction,
    sufficient: removedFraction >= minReductionRatio,
  }
}
