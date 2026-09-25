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
  checkpointEligible: boolean
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

export interface PreviousCheckpoint {
  messageIndex: number
  objective?: string
  sections: Partial<Record<
    "Objective" | "Constraints" | "Files in play" | "Decisions" | "Completed" | "Active work" | "Next move" | "Kept evidence",
    string
  >>
}

export interface ResolvedObjective {
  text: string
  source: "user" | "previous-checkpoint"
  textId?: string
}

export interface NormalizedTranscript {
  messages: TranscriptMessage[]
  textBlocks: TextBlock[]
  attachments: AttachmentBlock[]
  toolCalls: ToolCall[]
  toolResults: ToolResult[]
  previousCheckpoint?: PreviousCheckpoint
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
  keepCall?: number
  keepResult: number
  /** Legacy 0.0.5 field retained so historical diagnostics remain readable. */
  verification?: number
}

export interface ToolDecision {
  toolCallId: string
  decision: ToolDecisionKind
  reason: "pinned" | "policy" | "jev" | "uncertain"
  signals?: ToolSignals
}

export interface TextDecision {
  textId: string
  keep: boolean
  category: MessageCategory
  reason: "pinned" | "unknown-part" | "newest-user" | "jev" | "uncertain" | "retained-fact"
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
  objectiveText?: string
  objectiveTextId?: string
  tools: ToolDecision[]
  texts: TextDecision[]
  constraints: ConstraintDecision[]
  files: FileDecision[]
}

export interface ToolDecisionDiagnostic {
  toolCallId: string
  toolName: string
  action: ToolDecisionKind
  reason: ToolDecision["reason"]
  keepCall?: number
  keepResult?: number
  /** Legacy 0.0.5 field retained so historical records remain readable. */
  verification?: number
}

export interface CompactionStats {
  sessionID?: string
  pluginVersion?: string
  originalEstimatedTokens: number
  checkpointEstimatedTokens: number
  /** Representation-only size difference retained for diagnostics. Never authorizes compaction. */
  removedFraction: number
  remainingRatio: number
  /** Payload accounting over text/tool content, independent of JSON/Markdown serialization. */
  semanticPayloadCharsBefore: number
  semanticPayloadCharsAfter: number
  semanticRemovedFraction: number
  /** Deterministic upper bound before Jev runs. */
  maxPrunablePayloadChars: number
  maxPrunableFraction: number
  eligiblePrunableTools: number
  fittedStateEstimatedTokens: number
  fittedStateChars: number
  fitStage: string
  jevRequests: number
  /** Legacy metric. Single-pass 0.0.6 runs always record zero. */
  verificationRequests: number
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
  semanticReductionActions: number
  toolDecisionDiagnostics: ToolDecisionDiagnostic[]
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
