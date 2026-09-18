import type { JevState } from "./build.js"
import { estimateJsonTokens } from "./estimate.js"

export interface FitOptions {
  maxStateChars: number
  maxStateTokens: number
}

export type FitResult =
  | { ok: true; state: JevState; chars: number; tokens: number; stage: string }
  | { ok: false; reason: string; chars: number; tokens: number; stage: string }

function clone<T>(value: T): T {
  return structuredClone(value)
}

function measure(state: JevState): { chars: number; tokens: number } {
  const json = JSON.stringify(state)
  return { chars: json.length, tokens: estimateJsonTokens(state) }
}

function head(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n[… ${text.length - limit} chars omitted from fitted Jev state …]`
}

export function fitState(input: JevState, options: FitOptions): FitResult {
  const stages: Array<{ name: string; apply: (state: JevState) => void }> = [
    { name: "results-4000", apply: (state) => { for (const tool of state.tools) tool.result = head(tool.result, 4_000) } },
    { name: "results-2000", apply: (state) => { for (const tool of state.tools) tool.result = head(tool.result, 2_000) } },
    { name: "results-1000", apply: (state) => { for (const tool of state.tools) tool.result = head(tool.result, 1_000) } },
    { name: "inputs-1500", apply: (state) => { for (const tool of state.tools) tool.call = head(tool.call, 1_500) } },
    { name: "inputs-700", apply: (state) => { for (const tool of state.tools) tool.call = head(tool.call, 700) } },
    { name: "older-assistant-1500", apply: (state) => { for (const block of state.textBlocks) if (block.role === "assistant" && !block.pinned) block.text = head(block.text, 1_500) } },
    { name: "older-assistant-700", apply: (state) => { for (const block of state.textBlocks) if (block.role === "assistant" && !block.pinned) block.text = head(block.text, 700) } },
  ]

  const state = clone(input)
  let measured = measure(state)
  if (measured.chars <= options.maxStateChars && measured.tokens <= options.maxStateTokens) {
    return { ok: true, state, ...measured, stage: "none" }
  }

  for (const stage of stages) {
    stage.apply(state)
    measured = measure(state)
    if (measured.chars <= options.maxStateChars && measured.tokens <= options.maxStateTokens) {
      return { ok: true, state, ...measured, stage: stage.name }
    }
  }

  return {
    ok: false,
    reason: "state-cannot-fit",
    ...measured,
    stage: stages.at(-1)?.name ?? "none",
  }
}
