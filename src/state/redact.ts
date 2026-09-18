interface SecretPattern { pattern: RegExp; replacement: string | ((match: string, prefix: string) => string) }

const PATTERNS: SecretPattern[] = [
  { pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, replacement: "Bearer [REDACTED]" },
  { pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bgh[opusr]_[A-Za-z0-9]{20,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, replacement: "[REDACTED]" },
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, replacement: "[REDACTED PRIVATE KEY]" },
  {
    pattern: /(["']?(?:api[_-]?key|token|password|passwd|secret|client[_-]?secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
    replacement: (_match, prefix) => `${prefix}[REDACTED]`,
  },
]

export function redactSecrets(text: string): { text: string; count: number } {
  let result = text
  let count = 0
  for (const { pattern, replacement } of PATTERNS) {
    result = result.replace(pattern, (...args: unknown[]) => {
      count += 1
      if (typeof replacement === "string") return replacement
      const match = typeof args[0] === "string" ? args[0] : ""
      const prefix = typeof args[1] === "string" ? args[1] : ""
      return replacement(match, prefix)
    })
  }
  return { text: result, count }
}
