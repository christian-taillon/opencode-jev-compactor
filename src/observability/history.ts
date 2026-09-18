import type { CompactionRunRecord, CompactionStats } from "../domain/types.js"

export function makeRunRecord(
  status: CompactionRunRecord["status"],
  reason: string | null,
  stats: CompactionStats,
  at = new Date().toISOString(),
): CompactionRunRecord {
  return { at, status, reason, stats }
}

export function appendHistory(
  history: readonly CompactionRunRecord[],
  record: CompactionRunRecord,
  limit: number,
): CompactionRunRecord[] {
  return [...history, record].slice(-Math.max(1, limit))
}

function decisionLines(stats: CompactionStats): string[] {
  const values = stats.toolDecisionDiagnostics ?? []
  if (values.length === 0) return []
  const compact = values.slice(0, 12).map((item) => {
    const signals = [
      item.keepCall !== undefined ? `call=${item.keepCall.toFixed(2)}` : "",
      item.keepResult !== undefined ? `result=${item.keepResult.toFixed(2)}` : "",
      item.verification !== undefined ? `verify=${item.verification.toFixed(2)}` : "",
    ].filter(Boolean).join("/")
    return `${item.toolCallId}:${item.toolName}:${item.action}${signals ? `/${signals}` : ""}`
  })
  if (values.length > compact.length) compact.push(`…+${values.length - compact.length} more`)
  return [`decisions ${compact.join(" ")}`]
}

export function formatRun(record: CompactionRunRecord): string {
  const stats = record.stats
  const lines = [
    `${record.at}  ${record.status}${record.reason ? ` (${record.reason})` : ""}`,
    `session ${stats.sessionID ?? "unknown"}; plugin ${stats.pluginVersion ?? "pre-0.0.5"}`,
    `context ${stats.originalEstimatedTokens.toLocaleString()} -> checkpoint ${stats.checkpointEstimatedTokens.toLocaleString()} tokens; serialized reduction ${((stats.removedFraction ?? 0) * 100).toFixed(1)}%`,
    `semantic payload ${(stats.semanticPayloadCharsBefore ?? 0).toLocaleString()} -> ${(stats.semanticPayloadCharsAfter ?? 0).toLocaleString()} chars; removed ${((stats.semanticRemovedFraction ?? 0) * 100).toFixed(1)}%`,
    `semantic actions ${stats.semanticReductionActions ?? 0}; tools full/truncated/dropped ${stats.toolsKeptFull}/${stats.toolsTruncated}/${stats.toolsDropped}; text kept/dropped ${stats.textsKept}/${stats.textsDropped}`,
    `Jev ${stats.jevRequests} request(s) (${stats.verificationRequests ?? 0} verification), ${stats.jevInputTokens.toLocaleString()} input tokens, ${stats.jevLatencyMs} ms, est. $${stats.estimatedJevCostUsd.toFixed(6)}`,
    ...decisionLines(stats),
  ]
  return lines.join("\n")
}

export function formatHistory(history: readonly CompactionRunRecord[]): string {
  if (history.length === 0) return "No previous compaction runs."
  return history.map((record, index) => {
    const stats = record.stats
    const reason = record.reason ? ` (${record.reason})` : ""
    return `#${index + 1} ${record.at} ${record.status}${reason} | semantic ${((stats.semanticRemovedFraction ?? 0) * 100).toFixed(1)}% | Jev ${stats.jevRequests} req, ${stats.jevInputTokens.toLocaleString()} in, ${stats.jevLatencyMs} ms, $${stats.estimatedJevCostUsd.toFixed(6)}`
  }).join("\n")
}
