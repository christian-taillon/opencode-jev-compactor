const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g

/**
 * Conservative tokenizer-free estimate calibrated for JSON-heavy Jev requests.
 * Words cost roughly one token per six letters, digits one per two characters,
 * and punctuation slightly under one token each.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let tokens = 0
  for (const match of text.matchAll(TOKEN_PIECES)) {
    const piece = match[0]
    const first = piece.charCodeAt(0)
    if (first >= 48 && first <= 57) tokens += piece.length / 2
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6)
    } else {
      tokens += 0.9
    }
  }
  return Math.ceil(tokens)
}

export function estimateJsonTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value))
}
