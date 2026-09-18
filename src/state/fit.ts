import type { JevHistoryEntry, JevHistoryTool, JevState } from "./build.js"
import { estimateJsonTokens } from "./estimate.js"

export interface FitOptions {
  maxStateChars: number
  maxStateTokens: number
}

export type FitResult =
  | { ok: true; state: JevState; chars: number; tokens: number; stage: string }
  | { ok: false; reason: string; chars: number; tokens: number; stage: string }

const TEXT_HEAD = 400
const TEXT_TAIL = 150

function clone<T>(value: T): T {
  return structuredClone(value)
}

function measure(state: JevState): { chars: number; tokens: number } {
  const json = JSON.stringify(state)
  return { chars: json.length, tokens: estimateJsonTokens(state) }
}

function fits(state: JevState, options: FitOptions): boolean {
  const measured = measure(state)
  return measured.chars <= options.maxStateChars && measured.tokens <= options.maxStateTokens
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

function abridge(text: string, head = TEXT_HEAD, tail = TEXT_TAIL): string {
  if (text.length <= head + tail + 40) return text
  return `${text.slice(0, head)}\n[… ${text.length - head - tail} chars omitted …]\n${text.slice(-tail)}`
}

function structuredTools(entry: JevHistoryEntry): JevHistoryTool[] {
  return (entry.tool_calls ?? []).filter((tool): tool is JevHistoryTool => typeof tool !== "string")
}

function compactTool(tool: JevHistoryTool): string {
  const status = tool.result.status
  return `${tool.id} ${tool.name} ${truncate(tool.input.replace(/\s+/g, " "), 60)} → ${status} ${tool.result.chars}ch`
}

function mergeCallRuns(history: JevHistoryEntry[]): JevHistoryEntry[] {
  const merged: JevHistoryEntry[] = []
  for (const entry of history) {
    const previous = merged.at(-1)
    const foldable = (candidate: JevHistoryEntry | undefined): candidate is JevHistoryEntry =>
      Boolean(candidate && !candidate.pinned && !candidate.text && candidate.tool_calls?.length &&
        candidate.tool_calls.every((tool) => typeof tool === "string"))
    if (foldable(previous) && foldable(entry) && previous.role === entry.role) {
      previous.tool_calls = [...(previous.tool_calls ?? []), ...(entry.tool_calls ?? [])]
      continue
    }
    merged.push(entry)
  }
  return merged
}

function result(state: JevState, stage: string): FitResult {
  const measured = measure(state)
  return {
    ok: measured.chars <= Number.MAX_SAFE_INTEGER,
    state,
    ...measured,
    stage,
  } as FitResult
}

export function fitState(input: JevState, options: FitOptions): FitResult {
  const state = clone(input)
  const measured = () => measure(state)
  const success = (stage: string): FitResult => {
    const value = measured()
    return { ok: true, state, ...value, stage }
  }
  const check = (stage: string): FitResult | undefined =>
    fits(state, options) ? success(stage) : undefined

  let hit = check("full")
  if (hit) return hit

  for (const limit of [1000, 200, 60] as const) {
    for (const entry of state.history) {
      for (const tool of structuredTools(entry)) tool.input = truncate(tool.input, limit)
    }
    hit = check(`inputs<=${limit}`)
    if (hit) return hit
  }

  const order = [
    ...state.history.filter((entry) => !entry.pinned),
    ...state.history.filter((entry) => entry.pinned),
  ]
  for (const entry of order) {
    const next = abridge(entry.text)
    if (next === entry.text) continue
    entry.text = next
    hit = check("texts-abridged")
    if (hit) return hit
  }

  for (const entry of state.history) {
    if (entry.pinned || !entry.text) continue
    const chars = entry.text.length
    entry.text = `[… ${chars} chars omitted from older message …]`
    hit = check("old-messages-collapsed")
    if (hit) return hit
  }

  for (const entry of state.history) {
    if (entry.pinned || !entry.tool_calls?.length) continue
    const tools = structuredTools(entry)
    if (tools.length === 0) continue
    entry.tool_calls = tools.map(compactTool)
    hit = check("old-calls-compacted")
    if (hit) return hit
  }

  state.history = state.history.filter((entry) => entry.pinned || entry.tool_calls?.length)
  hit = check("old-callless-left-out")
  if (hit) return hit

  state.history = mergeCallRuns(state.history)
  hit = check("old-calls-merged")
  if (hit) return hit

  const final = measured()
  return {
    ok: false,
    reason: "state-cannot-fit",
    ...final,
    stage: "old-calls-merged",
  }
}
