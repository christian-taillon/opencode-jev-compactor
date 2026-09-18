export function estimateTokens(text: string): number {
  if (!text) return 0
  let letters = 0
  let digits = 0
  let other = 0
  for (const char of text) {
    if (/[A-Za-z]/.test(char)) letters += 1
    else if (/[0-9]/.test(char)) digits += 1
    else if (!/\s/.test(char)) other += 1
  }
  return Math.ceil(letters / 4.5 + digits / 2 + other * 0.8 + text.split(/\s+/).length * 0.15)
}

export function estimateJsonTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value))
}
