import type { ConstraintCandidate, FileCandidate, NormalizedTranscript, ResolvedObjective } from "../domain/types.js"
import { resolveObjective } from "../transcript/checkpoint-state.js"
import { redactSecrets } from "./redact.js"

export const STATE_CONTEXT =
  "An OpenCode coding conversation is being compacted. history is chronological and contains user/assistant text plus tool-call summaries. Tool results shown here are deliberately abbreviated; local originals remain available to application code. Judge whether tool provenance and exact tool-result content are still needed for correct continuation."

export interface JevHistoryTool {
  id: string
  name: string
  input: string
  result: {
    status: "ok" | "error" | "none"
    chars: number
    preview?: string
  }
  pinned: boolean
}

export interface JevHistoryEntry {
  i: number
  messageId: string
  role: string
  text: string
  pinned: boolean
  tool_calls?: Array<JevHistoryTool | string>
}

export interface JevState {
  context: string
  goal: string
  baseline: {
    objective?: string
    sections: Record<string, string>
  } | null
  history: JevHistoryEntry[]
}

export interface BuiltState {
  state: JevState
  objective?: ResolvedObjective
  files: FileCandidate[]
  constraints: ConstraintCandidate[]
  redactions: number
}

export interface BuildStateOptions {
  /** Small Jev-only preview. The original result is never modified. */
  toolResultPreviewChars: number
}

const PATH_RE = /(?:^|[\s"'=(])((?:\.\.?\/|\/|~\/)?(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+(?:\.[A-Za-z0-9_.-]+)?)/g

function preview(text: string, limit: number): string | undefined {
  if (limit <= 0 || text.length === 0) return undefined
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n[… ${text.length - limit} chars omitted from Jev state …]`
}

function extractFiles(text: string, source: string, map: Map<string, FileCandidate>): void {
  for (const match of text.matchAll(PATH_RE)) {
    const path = match[1]
    if (!path || path.length < 3 || path.startsWith("http")) continue
    const existing = map.get(path)
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source)
    } else {
      map.set(path, { id: `f${map.size}`, path, sources: [source] })
    }
  }
}

function extractConstraints(transcript: NormalizedTranscript): ConstraintCandidate[] {
  const out: ConstraintCandidate[] = []
  const seen = new Set<string>()
  const cue = /\b(must|never|do not|don't|required|requirement|only|without|cannot|can't|should not|preserve|avoid|fallback|prefer|keep)\b/i
  for (const block of transcript.textBlocks.filter((item) => item.role === "user" && item.checkpointEligible)) {
    for (const line of block.text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      if (!cue.test(line) || seen.has(line) || line.length > 700) continue
      seen.add(line)
      out.push({ id: `c${out.length}`, sourceTextId: block.id, text: line })
    }
  }
  return out.slice(-50)
}

export function buildJevState(transcript: NormalizedTranscript, options: BuildStateOptions): BuiltState {
  let redactions = 0
  const redact = (text: string): string => {
    const result = redactSecrets(text)
    redactions += result.count
    return result.text
  }

  const objective = resolveObjective(transcript)
  const filesMap = new Map<string, FileCandidate>()
  for (const block of transcript.textBlocks) extractFiles(block.text, block.id, filesMap)
  for (const call of transcript.toolCalls) {
    extractFiles(call.inputText, call.id, filesMap)
    if (call.result) extractFiles(call.result.text.slice(0, Math.max(0, options.toolResultPreviewChars)), call.id, filesMap)
  }
  for (const attachment of transcript.attachments) extractFiles(attachment.descriptor, attachment.id, filesMap)

  const callsByMessage = new Map<string, typeof transcript.toolCalls>()
  for (const call of transcript.toolCalls) {
    const list = callsByMessage.get(call.messageId) ?? []
    list.push(call)
    callsByMessage.set(call.messageId, list)
  }

  const history: JevHistoryEntry[] = []
  for (const message of transcript.messages) {
    const text = message.textBlocks
      .filter((block) => block.checkpointEligible)
      .map((block) => block.text)
      .join("\n")
      .trim()
    const calls = callsByMessage.get(message.id) ?? []
    if (!text && calls.length === 0) continue

    const entry: JevHistoryEntry = {
      i: message.index,
      messageId: message.id,
      role: message.role,
      text: redact(text),
      pinned: message.pinned,
    }
    if (calls.length > 0) {
      entry.tool_calls = calls.map((call): JevHistoryTool => {
        const raw = call.result?.text ?? ""
        const statePreview = preview(raw, options.toolResultPreviewChars)
        return {
          id: call.id,
          name: call.toolName,
          input: redact(call.inputText),
          result: {
            status: call.result ? (call.result.isError ? "error" : "ok") : "none",
            chars: raw.length,
            ...(statePreview ? { preview: redact(statePreview) } : {}),
          },
          pinned: call.pinned || call.result?.pinned === true,
        }
      })
    }
    history.push(entry)
  }

  const baseline = transcript.previousCheckpoint
    ? {
        ...(transcript.previousCheckpoint.objective ? { objective: redact(transcript.previousCheckpoint.objective) } : {}),
        sections: Object.fromEntries(
          Object.entries(transcript.previousCheckpoint.sections).map(([key, value]) => [key, redact(value)]),
        ),
      }
    : null

  const constraints = extractConstraints(transcript)
  return {
    state: {
      context: STATE_CONTEXT,
      goal: objective ? redact(objective.text) : "",
      baseline,
      history,
    },
    files: [...filesMap.values()],
    constraints,
    redactions,
    ...(objective ? { objective } : {}),
  }
}
