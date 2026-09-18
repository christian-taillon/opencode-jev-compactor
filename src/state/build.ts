import type { ConstraintCandidate, FileCandidate, NormalizedTranscript } from "../domain/types.js"
import { redactSecrets } from "./redact.js"

export interface JevStateTool {
  id: string
  name: string
  call: string
  result: string
  resultChars: number
  resultPreviewTruncated: boolean
  isError: boolean
  pinned: boolean
}

export interface JevStateMessage {
  id: string
  role: string
  text: string
  pinned: boolean
}

export interface JevStateText {
  id: string
  messageId: string
  role: string
  text: string
  pinned: boolean
  source: string
}

export interface JevState {
  goal: string
  objectiveCandidates: { id: string; text: string }[]
  recentTurns: JevStateMessage[]
  textBlocks: JevStateText[]
  tools: JevStateTool[]
  files: FileCandidate[]
  constraints: ConstraintCandidate[]
}

export interface BuiltState {
  state: JevState
  files: FileCandidate[]
  constraints: ConstraintCandidate[]
  redactions: number
}

export interface BuildStateOptions {
  toolResultPreviewChars: number
}

const PATH_RE = /(?:^|[\s"'=(])((?:\.\.?\/|\/|~\/)?(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+(?:\.[A-Za-z0-9_.-]+)?)/g

function preview(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n[... ${text.length - limit} chars omitted from Jev state preview ...]`
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
  for (const block of transcript.textBlocks.filter((item) => item.role === "user")) {
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

  const messageText = new Map<string, string>()
  for (const message of transcript.messages) {
    messageText.set(message.id, message.textBlocks.map((block) => block.text).join("\n"))
  }

  const messageViews = transcript.messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: redact(messageText.get(message.id) ?? ""),
    pinned: message.pinned,
  }))
  const recentTurns = messageViews.filter((message) => message.pinned).slice(-10)
  const textBlocks = transcript.textBlocks.map((block) => ({
    id: block.id,
    messageId: block.messageId,
    role: block.role,
    text: redact(block.text),
    pinned: block.pinned,
    source: block.source,
  }))
  const objectiveCandidates = transcript.messages
    .filter((message) => message.role === "user")
    .slice(-5)
    .map((message) => ({ id: message.id, text: redact(messageText.get(message.id) ?? "") }))
    .filter((candidate) => candidate.text.length > 0)
  const newestUserMessage = transcript.newestUserMessageId
    ? transcript.messages.find((message) => message.id === transcript.newestUserMessageId)
    : [...transcript.messages].reverse().find((message) => message.role === "user")
  const goal = newestUserMessage ? redact(messageText.get(newestUserMessage.id) ?? "") : ""

  const filesMap = new Map<string, FileCandidate>()
  const tools = transcript.toolCalls.map((call) => {
    extractFiles(call.inputText, call.id, filesMap)
    if (call.result) extractFiles(call.result.text.slice(0, options.toolResultPreviewChars), call.id, filesMap)
    const rawResult = call.result?.text ?? ""
    return {
      id: call.id,
      name: call.toolName,
      call: redact(call.inputText),
      result: redact(preview(rawResult, options.toolResultPreviewChars)),
      resultChars: rawResult.length,
      resultPreviewTruncated: rawResult.length > options.toolResultPreviewChars,
      isError: call.result?.isError ?? false,
      pinned: call.pinned || call.result?.pinned === true,
    }
  })

  for (const block of transcript.textBlocks) extractFiles(block.text, block.id, filesMap)
  for (const attachment of transcript.attachments) extractFiles(attachment.descriptor, attachment.id, filesMap)

  const constraints = extractConstraints(transcript)
  const stateConstraints = constraints.map((candidate) => ({ ...candidate, text: redact(candidate.text) }))
  return {
    state: {
      goal,
      objectiveCandidates,
      recentTurns,
      textBlocks,
      tools,
      files: [...filesMap.values()],
      constraints: stateConstraints,
    },
    files: [...filesMap.values()],
    constraints,
    redactions,
  }
}
