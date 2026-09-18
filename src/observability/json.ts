import type { JsonValue } from "../domain/types.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Convert application data to OpenCode storage-safe JSON without unsafe casts. */
export function toJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot persist a non-finite number")
    return value
  }
  if (Array.isArray(value)) return value.map((item) => toJson(item))
  if (isRecord(value)) {
    const output: Record<string, JsonValue> = {}
    for (const [key, nested] of Object.entries(value)) {
      if (nested === undefined) continue
      output[key] = toJson(nested)
    }
    return output
  }
  throw new Error(`Cannot persist value of type ${typeof value}`)
}
