export interface ReductionResult {
  originalTokens: number
  compactedTokens: number
  removedFraction: number
  remainingRatio: number
  sufficient: boolean
}

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
