export interface StructuredLog {
  event: string
  level?: "debug" | "info" | "warn" | "error"
  [key: string]: unknown
}

const PREFIX = "opencode.jev-compaction"

export function log(record: StructuredLog): void {
  const payload = { plugin: PREFIX, level: record.level ?? "info", ...record }
  const line = JSON.stringify(payload)
  if (payload.level === "error") console.error(line)
  else if (payload.level === "warn") console.warn(line)
  else console.log(line)
}
