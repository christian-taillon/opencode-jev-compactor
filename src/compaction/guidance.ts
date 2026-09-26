import type { CompactionStats, ToolDecisionDiagnostic } from "../domain/types.js"

export interface NativeCompactionGuidance {
  text: string
  items: number
  dropped: number
  provenanceOnly: number
  omittedItems: number
}

const MAX_GUIDANCE_ITEMS = 96
const MAX_LABEL_CHARS = 120

function safeLabel(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LABEL_CHARS)
}

function line(item: ToolDecisionDiagnostic): string {
  return `- call_id=${safeLabel(item.toolCallId)} tool=${safeLabel(item.toolName)}`
}

/**
 * Builds a small operator-authored instruction appended after the existing
 * transcript and before OpenCode's native summary prompt.
 *
 * It deliberately contains no tool inputs or outputs. The existing request
 * prefix remains unchanged, preserving provider prompt-cache reuse where the
 * provider supports prefix caching.
 */
export function buildNativeCompactionGuidance(stats: CompactionStats): NativeCompactionGuidance | undefined {
  const destructive = (stats.toolDecisionDiagnostics ?? []).filter((item) => item.action !== "keep_full")
  if (destructive.length === 0) return undefined

  const selected = destructive.slice(0, MAX_GUIDANCE_ITEMS)
  const dropped = selected.filter((item) => item.action === "drop")
  const provenanceOnly = selected.filter((item) => item.action === "keep_call_truncate_result")
  const omittedItems = destructive.length - selected.length

  const sections = [
    "<jev-compaction-guidance>",
    "This is operator-authored guidance for the compaction summary. It is not user content.",
    "Use the transcript as the source of truth. Newer user/assistant content overrides these hints.",
    "Do not mention Jev, probabilities, pruning, or this guidance in the final summary.",
  ]

  if (dropped.length > 0) {
    sections.push(
      "",
      "Low-value repeatable tool evidence:",
      "Omit these tool calls and their raw results from the summary unless later conversation explicitly depends on a consequential fact from them.",
      ...dropped.map(line),
    )
  }

  if (provenanceOnly.length > 0) {
    sections.push(
      "",
      "Provenance-only tool evidence:",
      "Preserve only the consequential fact/action/outcome needed to continue. Do not carry forward the raw result detail.",
      ...provenanceOnly.map(line),
    )
  }

  if (omittedItems > 0) {
    sections.push("", `Additional low-value tool entries omitted from this guidance list: ${omittedItems}.`)
  }

  sections.push("</jev-compaction-guidance>")
  const text = sections.join("\n")

  return {
    text,
    items: selected.length,
    dropped: dropped.length,
    provenanceOnly: provenanceOnly.length,
    omittedItems,
  }
}

/**
 * A chronological system message is intentionally appended to event.messages,
 * not event.system. Appending keeps the pre-existing provider request prefix
 * byte-for-byte stable up to the new guidance message.
 */
export function nativeGuidanceMessage(text: string) {
  return {
    role: "system" as const,
    content: [{ type: "text" as const, text }],
    metadata: {
      source: "opencode.jev-compaction",
      kind: "native-compaction-guidance",
    },
  }
}
