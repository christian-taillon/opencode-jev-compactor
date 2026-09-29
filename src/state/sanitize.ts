const CONTROL_AND_LINE_BREAKS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g

/**
 * Collapse host-controlled identifiers and names before embedding them in
 * Jev state, Jev instructions, or native compaction guidance.
 *
 * Conversation/tool payload text is not passed through this helper because
 * its semantics must remain intact.
 */
export function compactLabel(value: string, maxChars = 120): string {
  return value
    .replace(CONTROL_AND_LINE_BREAKS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(0, maxChars))
}
