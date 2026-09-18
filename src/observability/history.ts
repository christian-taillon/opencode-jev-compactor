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

export function formatRun(record: CompactionRunRecord): string {
  const stats = record.stats
  const lines = [
    `${record.at}  ${record.status}${record.reason ? ` (${record.reason})` : ""}`,
    `context ${stats.originalEstimatedTokens.toLocaleString()} -> checkpoint ${stats.checkpointEstimatedTokens.toLocaleString()} tokens; estimated serialized reduction ${(stats.removedFraction * 100).toFixed(1)}%`,
    `semantic actions ${stats.semanticReductionActions}; tools full/truncated/dropped ${stats.toolsKeptFull}/${stats.toolsTruncated}/${stats.toolsDropped}; text kept/dropped ${stats.textsKept}/${stats.textsDropped}`,
    `Jev ${stats.jevRequests} request(s), ${stats.jevInputTokens.toLocaleString()} input tokens, ${stats.jevLatencyMs} ms, est. $${stats.estimatedJevCostUsd.toFixed(6)}`,
  ]
  return lines.join("\n")
}

export function formatHistory(history: readonly CompactionRunRecord[]): string {
  if (history.length === 0) return "No previous compaction runs."
  return history.map((record, index) => {
    const stats = record.stats
    const reason = record.reason ? ` (${record.reason})` : ""
    return `#${index + 1} ${record.at} ${record.status}${reason} | ${stats.originalEstimatedTokens.toLocaleString()} -> ${stats.checkpointEstimatedTokens.toLocaleString()} tok | Jev ${stats.jevRequests} req, ${stats.jevInputTokens.toLocaleString()} in, ${stats.jevLatencyMs} ms, $${stats.estimatedJevCostUsd.toFixed(6)}`
  }).join("\n")
}
