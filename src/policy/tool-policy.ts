import type { ToolCall } from "../domain/types.js"

export type ToolRetentionPolicy = "pin_full" | "protect_call" | "drop_eligible"

const PIN_FULL_TOOLS = new Set([
  "question",
  "skill",
  "subagent",
])

const PROTECT_CALL_TOOLS = new Set([
  "write",
  "edit",
  "patch",
  "apply_patch",
  "shell",
  "bash",
  "execute",
  "webfetch",
  "websearch",
  "fetch",
  "download",
])

const DROP_ELIGIBLE_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "find",
  "list",
  "ls",
])

function normalizedToolName(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Destructive eligibility is application policy, not an AI judgment.
 *
 * Unknown, incomplete, pinned, and failed calls fail toward full retention.
 * Mutation/remote-action tools retain provenance but may have bulky successful
 * results truncated. Only an explicit allowlist of cheap, repeatable read-only
 * tools may lose both call and result.
 */
export function classifyTool(call: ToolCall): ToolRetentionPolicy {
  if (call.pinned || call.result?.pinned === true || !call.result || call.result.isError) return "pin_full"

  const name = normalizedToolName(call.toolName)
  if (PIN_FULL_TOOLS.has(name)) return "pin_full"
  if (DROP_ELIGIBLE_TOOLS.has(name)) return "drop_eligible"
  if (PROTECT_CALL_TOOLS.has(name)) return "protect_call"

  return "pin_full"
}
