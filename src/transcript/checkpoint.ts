import type {
  CompactionDecisions,
  ConstraintCandidate,
  FileCandidate,
  MessageCategory,
  NormalizedTranscript,
  TextBlock,
  ToolCall,
} from "../domain/types.js"

export interface CheckpointOptions {
  truncateHeadChars: number
}

function fence(text: string): string {
  let ticks = "```"
  while (text.includes(ticks)) ticks += "`"
  return `${ticks}text\n${text}\n${ticks}`
}

function exactTextEntry(block: TextBlock): string {
  return `### ${block.role} ${block.messageId}\n${fence(block.text)}`
}

function truncated(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n[checkpoint truncation: ${text.length - maxChars} trailing characters omitted]`
}

function toolEntry(call: ToolCall, decision: "keep_full" | "keep_call_truncate_result", maxChars: number): string {
  const lines = [`### tool ${call.toolName} (${call.id})`, "Call:", fence(call.inputText)]
  if (call.result) {
    lines.push("Result:")
    lines.push(fence(decision === "keep_full" ? call.result.text : truncated(call.result.text, maxChars)))
  }
  return lines.join("\n")
}

function keptTextByCategory(transcript: NormalizedTranscript, decisions: CompactionDecisions): Map<MessageCategory, TextBlock[]> {
  const keep = new Map(decisions.texts.filter((item) => item.keep).map((item) => [item.textId, item] as const))
  const grouped = new Map<MessageCategory, TextBlock[]>()
  for (const block of transcript.textBlocks) {
    const decision = keep.get(block.id)
    if (!decision) continue
    const list = grouped.get(decision.category) ?? []
    list.push(block)
    grouped.set(decision.category, list)
  }
  return grouped
}

function uniqueEntries(blocks: readonly TextBlock[], emitted: Set<string>): string[] {
  const entries: string[] = []
  for (const block of blocks) {
    if (emitted.has(block.id)) continue
    emitted.add(block.id)
    entries.push(exactTextEntry(block))
  }
  return entries
}

export function assembleCheckpoint(
  transcript: NormalizedTranscript,
  constraints: ConstraintCandidate[],
  files: FileCandidate[],
  decisions: CompactionDecisions,
  options: CheckpointOptions,
): string {
  const grouped = keptTextByCategory(transcript, decisions)
  const emitted = new Set<string>()
  const objective = decisions.objectiveTextId
    ? transcript.textBlocks.find((block) => block.id === decisions.objectiveTextId)
    : undefined
  const keptConstraints = new Set(decisions.constraints.filter((item) => item.keep).map((item) => item.id))
  const keptFiles = new Set(decisions.files.filter((item) => item.keep).map((item) => item.id))
  const toolDecisions = new Map(decisions.tools.map((item) => [item.toolCallId, item.decision] as const))

  const sections: string[] = []
  const add = (heading: string, entries: string[]) => {
    sections.push(`## ${heading}`)
    sections.push(entries.length > 0 ? entries.join("\n\n") : "- None retained")
  }

  if (objective) emitted.add(objective.id)
  add("Objective", objective ? [exactTextEntry(objective)] : [])
  add("Constraints", constraints.filter((candidate) => keptConstraints.has(candidate.id)).map((candidate) => `- ${candidate.text}`))
  add("Files in play", files.filter((file) => keptFiles.has(file.id)).map((file) => `- \`${file.path}\``))
  add("Decisions", uniqueEntries(grouped.get("decision") ?? [], emitted))
  add("Completed", uniqueEntries(grouped.get("completed") ?? [], emitted))
  add("Active work", [
    ...uniqueEntries(grouped.get("active") ?? [], emitted),
    ...uniqueEntries(grouped.get("constraint") ?? [], emitted),
  ])
  add("Next move", uniqueEntries(grouped.get("next_move") ?? [], emitted))

  const evidence = [
    ...uniqueEntries(grouped.get("evidence") ?? [], emitted),
    ...uniqueEntries(grouped.get("objective") ?? [], emitted),
  ]
  for (const attachment of transcript.attachments) {
    evidence.push(`- Retained attachment descriptor: ${attachment.descriptor}`)
  }
  for (const call of transcript.toolCalls) {
    const decision = toolDecisions.get(call.id)
    if (decision === "keep_full" || decision === "keep_call_truncate_result") {
      evidence.push(toolEntry(call, decision, options.truncateHeadChars))
    }
  }
  add("Kept evidence", evidence)
  return sections.join("\n\n").trim()
}
