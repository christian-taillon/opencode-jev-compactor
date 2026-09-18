export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type Role = "system" | "user" | "assistant" | "tool" | "unknown"

export interface TextBlock {
  id: string
  messageId: string
  messageIndex: number
  role: Role
  text: string
  source: "content" | "text-part" | "reasoning" | "unknown-part"
  pinned: boolean
}

export interface AttachmentBlock {
  id: string
  messageId: string
  messageIndex: number
  role: Role
  descriptor: string
  pinned: boolean
}

export interface ToolResult {
  id: string
  toolCallId: string
  messageId: string
  messageIndex: number
  toolName?: string
  text: string
  isError: boolean
  pinned: boolean
}

export interface ToolCall {
  id: string
  messageId: string
  messageIndex: number
  toolName: string
  inputText: string
  pinned: boolean
  result?: ToolResult
}

export interface TranscriptMessage {
  id: string
  index: number
  role: Role
  textBlocks: TextBlock[]
  attachmentBlocks: AttachmentBlock[]
  toolCallIds: string[]
  toolResultIds: string[]
  hasUnknownParts: boolean
  pinned: boolean
}

export interface NormalizedTranscript {
  messages: TranscriptMessage[]
  textBlocks: TextBlock[]
  attachments: AttachmentBlock[]
  toolCalls: ToolCall[]
  toolResults: ToolResult[]
  newestUserMessageId?: string
  firstMessageId?: string
}

export interface ConstraintCandidate {
  id: string
  sourceTextId: string
  text: string
}

export interface FileCandidate {
  id: string
  path: string
  sources: string[]
}

export type MessageCategory =
  | "objective"
  | "constraint"
  | "decision"
  | "completed"
  | "active"
  | "next_move"
  | "evidence"
  | "irrelevant"

export type ToolDecisionKind = "keep_full" | "keep_call_truncate_result" | "drop"

export interface ToolSignals {
  keepCall: number
  exactEvidence: number
  unresolvedBlocker: number
  completedWork: number
  repeatWorkRisk: number
  superseded: number
  truncateSafe: number
  safeToDiscard: number
  relevance: number
  relevanceConfidence: number
  choice: ToolDecisionKind
  choiceConfidence: number
  choiceProbabilities: Record<string, number>
}

export interface TextSignals {
  keep: number
  safeToDiscard: number
  superseded: number
  relevance: number
  relevanceConfidence: number
  category: MessageCategory
  categoryConfidence: number
  categoryProbabilities: Record<string, number>
}

export interface ToolDecision {
  toolCallId: string
  decision: ToolDecisionKind
  reason: "pinned" | "jev" | "uncertain"
  signals?: ToolSignals
}

export interface TextDecision {
  textId: string
  keep: boolean
  category: MessageCategory
  reason: "pinned" | "unknown-part" | "newest-user" | "jev" | "uncertain" | "retained-fact"
  signals?: TextSignals
}

export interface ConstraintDecision {
  id: string
  keep: boolean
  probability: number
}

export interface FileDecision {
  id: string
  keep: boolean
  probability: number
}

export interface CompactionDecisions {
  objectiveTextId?: string
  tools: ToolDecision[]
  texts: TextDecision[]
  constraints: ConstraintDecision[]
  files: FileDecision[]
}

export interface CompactionStats {
  originalEstimatedTokens: number
  checkpointEstimatedTokens: number
  removedFraction: number
  remainingRatio: number
  fittedStateEstimatedTokens: number
  fittedStateChars: number
  fitStage: string
  jevRequests: number
  jevInputTokens: number
  jevOutputTokens: number
  jevLatencyMs: number
  estimatedJevCostUsd: number
  toolsScored: number
  toolsKeptFull: number
  toolsTruncated: number
  toolsDropped: number
  textsScored: number
  textsKept: number
  textsDropped: number
  redactions: number
  fallbackReason?: string
}

export interface Checkpoint {
  summary: string
  stats: CompactionStats
}

export type CompactionOutcome =
  | { status: "ok"; checkpoint: Checkpoint; decisions: CompactionDecisions }
  | { status: "fallback"; reason: string; stats: CompactionStats }
  | { status: "error"; reason: string; stats: CompactionStats }

export interface CompactionRunRecord {
  at: string
  status: "ok" | "fallback" | "error" | "disabled"
  reason: string | null
  stats: CompactionStats
}
