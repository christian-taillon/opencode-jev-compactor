import type { NormalizedTranscript, PreviousCheckpoint, ResolvedObjective } from "../domain/types.js"

export const CHECKPOINT_SECTIONS = [
  "Objective",
  "Constraints",
  "Files in play",
  "Decisions",
  "Completed",
  "Active work",
  "Next move",
  "Kept evidence",
] as const

export type CheckpointSection = (typeof CHECKPOINT_SECTIONS)[number]

type ParsedCheckpoint = Omit<PreviousCheckpoint, "messageIndex">

const CHECKPOINT_ENVELOPE = /<conversation-checkpoint(?:\s[^>]*)?>([\s\S]*?)<\/conversation-checkpoint>/gi
const SECTION_HEADING = /^##\s+(Objective|Constraints|Files in play|Decisions|Completed|Active work|Next move|Kept evidence)\s*$/gm
const EMPTY_SECTION = /^-\s+(?:None retained|None|N\/A)\.?$/i

function normalizeSectionBody(body: string): string | undefined {
  const trimmed = body.trim()
  if (!trimmed || EMPTY_SECTION.test(trimmed)) return undefined
  return trimmed
}

export function parseCheckpointMarkdown(markdown: string): ParsedCheckpoint | undefined {
  const matches = [...markdown.matchAll(SECTION_HEADING)]
  if (matches.length === 0) return undefined

  const sections: PreviousCheckpoint["sections"] = {}
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const heading = match?.[1] as CheckpointSection | undefined
    if (!match || !heading || match.index === undefined) continue
    const bodyStart = match.index + match[0].length
    const bodyEnd = matches[index + 1]?.index ?? markdown.length
    const body = normalizeSectionBody(markdown.slice(bodyStart, bodyEnd))
    if (body) sections[heading] = body
  }

  if (Object.keys(sections).length === 0) return undefined
  const objective = sections.Objective ? plainObjective(sections.Objective) : undefined
  return {
    sections,
    ...(objective ? { objective } : {}),
  }
}

export function extractCheckpointEnvelope(text: string): {
  checkpoint?: ParsedCheckpoint
  remainder: string
} {
  let checkpoint: ParsedCheckpoint | undefined
  const remainder = text.replace(CHECKPOINT_ENVELOPE, (_full, inner: string) => {
    const parsed = parseCheckpointMarkdown(inner)
    if (parsed) checkpoint = parsed
    return ""
  }).trim()
  return { ...(checkpoint ? { checkpoint } : {}), remainder }
}

export function plainObjective(sectionBody: string): string {
  const fence = sectionBody.match(/(`{3,})[^\n]*\n([\s\S]*?)\n\1/)
  if (fence?.[2]?.trim()) return fence[2].trim()

  const withoutSubheadings = sectionBody
    .split(/\r?\n/)
    .filter((line) => !/^###\s+/.test(line.trim()))
    .join("\n")
    .trim()
  return withoutSubheadings.replace(/^[-*]\s+/, "").trim()
}

export function isWeakFollowUp(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[.!?,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!normalized) return true
  if (/^(?:more\s*)+$/.test(normalized)) return true
  return /^(?:please\s+)?(?:continue|go on|keep going|carry on|proceed|next)(?:\s+please)?$/.test(normalized)
}

function messageText(transcript: NormalizedTranscript, messageId: string): string {
  return transcript.textBlocks
    .filter((block) => block.messageId === messageId && block.role === "user")
    .map((block) => block.text)
    .join("\n")
    .trim()
}

export function resolveObjective(transcript: NormalizedTranscript): ResolvedObjective | undefined {
  const newestUserId = transcript.newestUserMessageId
  const newestText = newestUserId ? messageText(transcript, newestUserId) : ""

  if (newestText && !isWeakFollowUp(newestText)) {
    const block = transcript.textBlocks.find((item) => item.messageId === newestUserId && item.role === "user")
    return {
      text: newestText,
      source: "user",
      ...(block ? { textId: block.id } : {}),
    }
  }

  const previousObjective = transcript.previousCheckpoint?.objective?.trim()
  if (previousObjective) {
    return { text: previousObjective, source: "previous-checkpoint" }
  }

  const userMessages = [...transcript.messages].reverse().filter((message) => message.role === "user")
  for (const message of userMessages) {
    if (message.id === newestUserId) continue
    const text = messageText(transcript, message.id)
    if (!text || isWeakFollowUp(text)) continue
    const block = transcript.textBlocks.find((item) => item.messageId === message.id && item.role === "user")
    return {
      text,
      source: "user",
      ...(block ? { textId: block.id } : {}),
    }
  }
  return undefined
}
