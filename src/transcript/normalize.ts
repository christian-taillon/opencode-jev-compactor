import type {
  AttachmentBlock,
  NormalizedTranscript,
  PreviousCheckpoint,
  Role,
  TextBlock,
  ToolCall,
  ToolResult,
  TranscriptMessage,
} from "../domain/types.js"
import { extractCheckpointEnvelope, parseCheckpointMarkdown } from "./checkpoint-state.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string") return value
  }
  return undefined
}

function roleOf(value: unknown): Role {
  if (value === "system" || value === "user" || value === "assistant" || value === "tool") return value
  return "unknown"
}

function messageRole(record: Record<string, unknown>): Role {
  const explicit = roleOf(record.role)
  if (explicit !== "unknown") return explicit
  const type = readString(record, "type")
  if (type === "user") return "user"
  if (type === "assistant") return "assistant"
  if (type === "system" || type === "synthetic" || type === "skill" || type === "compaction") return "system"
  if (type === "shell" || type === "tool") return "tool"
  return "unknown"
}

const CONTROL_TYPES = new Set([
  "effort",
  "metadata",
  "usage",
  "token-usage",
  "token_usage",
  "step-start",
  "step_start",
  "step-finish",
  "step_finish",
])

function isControlRecord(record: Record<string, unknown>): boolean {
  const type = readString(record, "type")
  return type !== undefined && CONTROL_TYPES.has(type)
}

export function safeStringify(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined) return ""
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(
      value,
      (_key, nested) => {
        if (typeof nested === "bigint") return nested.toString()
        if (typeof nested === "object" && nested !== null) {
          if (seen.has(nested)) return "[Circular]"
          seen.add(nested)
        }
        return nested
      },
      2,
    )
  } catch {
    return String(value)
  }
}

function contentItems(message: Record<string, unknown>): unknown[] {
  const content = message.content
  if (Array.isArray(content)) return [...content]
  if (typeof content === "string") return [{ type: "text", text: content }]
  const parts = message.parts
  if (Array.isArray(parts)) return [...parts]
  return []
}

function toolInputText(part: Record<string, unknown>): string {
  return safeStringify(part.input ?? part.args ?? part.arguments ?? part.parameters)
}

function toolResultText(part: Record<string, unknown>): string {
  const direct = readString(part, "text", "outputText", "errorText")
  if (direct !== undefined) return direct
  const value = part.output ?? part.result ?? part.content ?? part.value
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    const textParts = value
      .map((entry) => {
        if (typeof entry === "string") return entry
        if (!isRecord(entry)) return safeStringify(entry)
        return readString(entry, "text", "value") ?? safeStringify(entry)
      })
      .filter((entry) => entry.length > 0)
    if (textParts.length > 0) return textParts.join("\n")
  }
  return safeStringify(value)
}

function openCodeToolResult(part: Record<string, unknown>): { text: string; isError: boolean } | undefined {
  if (!isRecord(part.result)) return undefined
  const result = part.result
  const type = readString(result, "type")
  if (type === "text" || type === "error") {
    const value = result.value
    return {
      text: typeof value === "string" ? value : safeStringify(value),
      isError: type === "error",
    }
  }
  if (type === "json") return { text: safeStringify(result.value), isError: false }
  if (type === "content" && Array.isArray(result.value)) {
    return {
      text: result.value.map((entry) => {
        if (!isRecord(entry)) return safeStringify(entry)
        if (entry.type === "text" && typeof entry.text === "string") return entry.text
        return attachmentDescriptor(entry)
      }).join("\n"),
      isError: false,
    }
  }
  return undefined
}

function openCodeToolStateResultText(state: Record<string, unknown>): string {
  const content = toolResultText(state)
  if (state.status !== "error") return content
  const serializedError = state.error === undefined ? "" : safeStringify(state.error)
  if (content.length === 0) return serializedError
  if (serializedError.length === 0) return content
  return `${content}\n${serializedError}`
}

function attachmentDescriptor(part: Record<string, unknown>): string {
  const type = readString(part, "type") ?? "attachment"
  const name = readString(part, "filename", "name", "title")
  const mediaType = readString(part, "mediaType", "mimeType", "mime_type", "mime")
  const path = readString(part, "path")
  const url = readString(part, "url", "uri")
  const pieces = [type]
  if (name) pieces.push(`name=${name}`)
  if (mediaType) pieces.push(`mediaType=${mediaType}`)
  if (path) pieces.push(`path=${path}`)
  if (url) pieces.push(`uri=${url}`)
  return pieces.join(" ")
}

function isToolCallType(type: string): boolean {
  return type === "tool-call" || type === "tool_call" || type === "tool-use" || type === "tool_use"
}

function isToolResultType(type: string): boolean {
  return type === "tool-result" || type === "tool_result" || type === "tool-output" || type === "tool_output" || type === "tool-error" || type === "tool_error"
}

function isAttachmentType(type: string): boolean {
  return type === "file" || type === "image" || type === "media" || type === "attachment" || type === "resource"
}

function pinTranscript(transcript: NormalizedTranscript, preserveRecentMessages: number): void {
  const first = transcript.messages[0]
  if (!first) return
  first.pinned = true
  const recentStart = Math.max(0, transcript.messages.length - preserveRecentMessages)
  for (let index = recentStart; index < transcript.messages.length; index += 1) {
    const message = transcript.messages[index]
    if (message) message.pinned = true
  }
  const newestUser = [...transcript.messages].reverse().find((message) => message.role === "user")
  if (newestUser) {
    newestUser.pinned = true
    transcript.newestUserMessageId = newestUser.id
  }
  transcript.firstMessageId = first.id

  const pinnedMessageIds = new Set(transcript.messages.filter((message) => message.pinned).map((message) => message.id))
  for (const text of transcript.textBlocks) text.pinned = text.pinned || pinnedMessageIds.has(text.messageId)
  for (const attachment of transcript.attachments) attachment.pinned = attachment.pinned || pinnedMessageIds.has(attachment.messageId)
  for (const call of transcript.toolCalls) call.pinned = call.pinned || pinnedMessageIds.has(call.messageId)
  for (const result of transcript.toolResults) result.pinned = result.pinned || pinnedMessageIds.has(result.messageId)
}

/** Raw OpenCode v2 messages are isolated at this boundary and normalized into stable domain types. */
export function normalizeOpenCodeMessages(rawMessages: readonly unknown[], preserveRecentMessages: number): NormalizedTranscript {
  const messages: TranscriptMessage[] = []
  const textBlocks: TextBlock[] = []
  const attachments: AttachmentBlock[] = []
  const toolCalls: ToolCall[] = []
  const toolResults: ToolResult[] = []
  let previousCheckpoint: PreviousCheckpoint | undefined

  const recordCheckpoint = (messageIndex: number, parsed: Omit<PreviousCheckpoint, "messageIndex"> | undefined) => {
    if (!parsed) return
    if (!previousCheckpoint || messageIndex >= previousCheckpoint.messageIndex) {
      previousCheckpoint = { messageIndex, ...parsed }
    }
  }

  const addText = (
    message: TranscriptMessage,
    messageIndex: number,
    partIndex: number,
    role: Role,
    rawText: string,
    source: TextBlock["source"],
  ) => {
    const extracted = extractCheckpointEnvelope(rawText)
    recordCheckpoint(messageIndex, extracted.checkpoint)
    const value = extracted.remainder
    if (!value || role === "system" || source === "reasoning") return
    const text: TextBlock = {
      id: `${message.id}:${source === "content" ? "text" : source}:${partIndex}`,
      messageId: message.id,
      messageIndex,
      role,
      text: value,
      source,
      pinned: false,
      checkpointEligible: true,
    }
    textBlocks.push(text)
    message.textBlocks.push(text)
  }

  for (let messageIndex = 0; messageIndex < rawMessages.length; messageIndex += 1) {
    const raw = rawMessages[messageIndex]
    const record = isRecord(raw) ? raw : { content: safeStringify(raw), role: "unknown" }
    const role = messageRole(record)
    const messageId = readString(record, "id", "messageID", "messageId") ?? `m${messageIndex}`
    const message: TranscriptMessage = {
      id: messageId,
      index: messageIndex,
      role,
      textBlocks: [],
      attachmentBlocks: [],
      toolCallIds: [],
      toolResultIds: [],
      hasUnknownParts: false,
      pinned: false,
    }

    if (record.type === "compaction" && typeof record.summary === "string") {
      recordCheckpoint(messageIndex, parseCheckpointMarkdown(record.summary))
    }

    const items = contentItems(record)
    if (items.length === 0 && typeof record.text === "string") items.push({ type: "text", text: record.text })
    if (Array.isArray(record.files)) {
      for (const file of record.files) items.push(isRecord(file) ? file : { type: "file", value: file })
    }

    if (record.type === "shell") {
      const callId = readString(record, "id", "shellID", "shellId") ?? `${messageId}:shell`
      const call: ToolCall = {
        id: callId,
        messageId,
        messageIndex,
        toolName: "shell",
        inputText: readString(record, "command") ?? safeStringify(record.command),
        pinned: false,
      }
      toolCalls.push(call)
      message.toolCallIds.push(callId)
      if (record.output !== undefined) {
        const outputRecord = isRecord(record.output) ? record.output : { output: record.output }
        const result: ToolResult = {
          id: `${callId}:result:${messageIndex}`,
          toolCallId: callId,
          messageId,
          messageIndex,
          toolName: "shell",
          text: toolResultText(outputRecord),
          isError: outputRecord.status === "error" || (typeof outputRecord.exitCode === "number" && outputRecord.exitCode !== 0),
          pinned: false,
        }
        toolResults.push(result)
        message.toolResultIds.push(result.id)
      }
    }

    for (let partIndex = 0; partIndex < items.length; partIndex += 1) {
      const rawPart = items[partIndex]
      if (typeof rawPart === "string") {
        addText(message, messageIndex, partIndex, role, rawPart, "content")
        continue
      }
      if (!isRecord(rawPart)) {
        if (role === "system") continue
        const text: TextBlock = {
          id: `${messageId}:unknown:${partIndex}`,
          messageId,
          messageIndex,
          role,
          text: safeStringify(rawPart),
          source: "unknown-part",
          pinned: true,
          checkpointEligible: true,
        }
        textBlocks.push(text)
        message.textBlocks.push(text)
        message.hasUnknownParts = true
        continue
      }

      const type = readString(rawPart, "type") ?? "unknown"
      if (CONTROL_TYPES.has(type)) continue
      if (type === "reasoning") continue
      if (type === "compaction") {
        if (typeof rawPart.text === "string") recordCheckpoint(messageIndex, parseCheckpointMarkdown(rawPart.text))
        continue
      }
      if (type === "text") {
        addText(message, messageIndex, partIndex, role, readString(rawPart, "text", "value") ?? "", "text-part")
        continue
      }

      if (isToolCallType(type)) {
        const id = readString(rawPart, "toolCallId", "tool_call_id", "toolUseId", "tool_use_id", "id") ?? `${messageId}:tool:${partIndex}`
        const toolName = readString(rawPart, "toolName", "tool_name", "name", "tool") ?? "unknown_tool"
        const call: ToolCall = { id, messageId, messageIndex, toolName, inputText: toolInputText(rawPart), pinned: false }
        toolCalls.push(call)
        message.toolCallIds.push(id)
        continue
      }

      if (type === "tool" && isRecord(rawPart.state)) {
        const state = rawPart.state
        const id = readString(rawPart, "id", "toolCallId", "tool_call_id") ?? `${messageId}:tool:${partIndex}`
        const toolName = readString(rawPart, "name", "toolName", "tool_name") ?? "unknown_tool"
        const call: ToolCall = { id, messageId, messageIndex, toolName, inputText: safeStringify(state.input), pinned: false }
        toolCalls.push(call)
        message.toolCallIds.push(id)
        if (state.status === "completed" || state.status === "error") {
          const result: ToolResult = {
            id: `${id}:result:${messageIndex}:${partIndex}`,
            toolCallId: id,
            messageId,
            messageIndex,
            toolName,
            text: openCodeToolStateResultText(state),
            isError: state.status === "error",
            pinned: false,
          }
          toolResults.push(result)
          message.toolResultIds.push(result.id)
        }
        continue
      }

      if (isToolResultType(type)) {
        const callId = readString(rawPart, "toolCallId", "tool_call_id", "toolUseId", "tool_use_id", "id") ?? `${messageId}:orphan:${partIndex}`
        const toolName = readString(rawPart, "toolName", "tool_name", "name", "tool")
        const nativeResult = openCodeToolResult(rawPart)
        const result: ToolResult = {
          id: `${callId}:result:${messageIndex}:${partIndex}`,
          toolCallId: callId,
          messageId,
          messageIndex,
          ...(toolName ? { toolName } : {}),
          text: nativeResult?.text ?? toolResultText(rawPart),
          isError: nativeResult?.isError === true || rawPart.isError === true || rawPart.error === true || type === "tool-error" || type === "tool_error",
          pinned: false,
        }
        toolResults.push(result)
        message.toolResultIds.push(result.id)
        continue
      }

      if (isAttachmentType(type)) {
        const attachment: AttachmentBlock = {
          id: `${messageId}:attachment:${partIndex}`,
          messageId,
          messageIndex,
          role,
          descriptor: attachmentDescriptor(rawPart),
          pinned: false,
        }
        attachments.push(attachment)
        message.attachmentBlocks.push(attachment)
        continue
      }

      if (role === "system") continue
      const unknown: TextBlock = {
        id: `${messageId}:unknown:${partIndex}`,
        messageId,
        messageIndex,
        role,
        text: safeStringify(rawPart),
        source: "unknown-part",
        pinned: true,
        checkpointEligible: true,
      }
      textBlocks.push(unknown)
      message.textBlocks.push(unknown)
      message.hasUnknownParts = true
    }

    if (
      message.textBlocks.length === 0 &&
      message.attachmentBlocks.length === 0 &&
      message.toolCallIds.length === 0 &&
      message.toolResultIds.length === 0 &&
      role === "unknown" &&
      !isControlRecord(record)
    ) {
      const unknown: TextBlock = {
        id: `${messageId}:unknown-message`,
        messageId,
        messageIndex,
        role,
        text: safeStringify(record),
        source: "unknown-part",
        pinned: true,
        checkpointEligible: true,
      }
      textBlocks.push(unknown)
      message.textBlocks.push(unknown)
      message.hasUnknownParts = true
    }
    messages.push(message)
  }

  const baselineIndex = previousCheckpoint?.messageIndex ?? -1
  const activeMessages = messages.filter((message) => message.index > baselineIndex)
  const activeTextBlocks = textBlocks.filter((block) => block.messageIndex > baselineIndex)
  const activeAttachments = attachments.filter((attachment) => attachment.messageIndex > baselineIndex)
  const activeToolCalls = toolCalls.filter((call) => call.messageIndex > baselineIndex)
  const activeToolResults = toolResults.filter((result) => result.messageIndex > baselineIndex)

  const callsById = new Map(activeToolCalls.map((call) => [call.id, call] as const))
  for (const result of activeToolResults) {
    const call = callsById.get(result.toolCallId)
    if (call) {
      call.result = result
      continue
    }
    const synthetic: ToolCall = {
      id: result.toolCallId,
      messageId: result.messageId,
      messageIndex: result.messageIndex,
      toolName: result.toolName ?? "unknown_tool",
      inputText: "",
      pinned: result.pinned,
      result,
    }
    activeToolCalls.push(synthetic)
    callsById.set(synthetic.id, synthetic)
  }

  const transcript: NormalizedTranscript = {
    messages: activeMessages,
    textBlocks: activeTextBlocks,
    attachments: activeAttachments,
    toolCalls: activeToolCalls,
    toolResults: activeToolResults,
    ...(previousCheckpoint ? { previousCheckpoint } : {}),
  }
  pinTranscript(transcript, preserveRecentMessages)
  return transcript
}
