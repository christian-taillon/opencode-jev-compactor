import type { JevAsker } from "../compaction/engine.js"
import { compareWithJev } from "../jev/compare.js"

interface CompareToolInput {
  left: string
  right: string
  criterion: string
  context?: string
}

function parseCompareInput(input: unknown): CompareToolInput {
  if (typeof input !== "object" || input === null) throw new Error("jev_compare input must be an object")
  const record = input as Record<string, unknown>
  if (typeof record.left !== "string" || typeof record.right !== "string" || typeof record.criterion !== "string") {
    throw new Error("jev_compare requires string fields left, right, and criterion")
  }
  return {
    left: record.left,
    right: record.right,
    criterion: record.criterion,
    ...(typeof record.context === "string" ? { context: record.context } : {}),
  }
}

export function makeCompareTool(asker: JevAsker) {
  return {
    name: "jev_compare",
    description: "Compare two snippets against one criterion with TypeSafe Jev using structured Choice and Score answers.",
    input: {
      type: "object" as const,
      properties: {
        left: { type: "string" as const, description: "First snippet or candidate." },
        right: { type: "string" as const, description: "Second snippet or candidate." },
        criterion: { type: "string" as const, description: "Single comparison or relevance criterion." },
        context: { type: "string" as const, description: "Optional concise context needed to judge the criterion." },
      },
      required: ["left", "right", "criterion"],
      additionalProperties: false,
    },
    execute: async (rawInput: unknown, toolContext: unknown) => {
      try {
        const signal = typeof toolContext === "object" && toolContext !== null && (toolContext as { abort?: unknown }).abort instanceof AbortSignal
          ? (toolContext as { abort: AbortSignal }).abort
          : undefined
        const result = await compareWithJev(asker, parseCompareInput(rawInput), signal)
        return { content: JSON.stringify({ ok: true, ...result }) }
      } catch (error) {
        const type = error instanceof Error ? error.name : "Error"
        return { content: JSON.stringify({ ok: false, error: type }) }
      }
    },
  }
}
