import { randomUUID } from "node:crypto"
import { compactTranscript, initialCompactionStats, PLUGIN_VERSION } from "./compaction/engine.js"
import { buildNativeCompactionGuidance } from "./compaction/guidance.js"
import type { CompactionRunRecord } from "./domain/types.js"
import { JevClient } from "./jev/client.js"
import { appendHistory, formatRun, makeRunRecord } from "./observability/history.js"
import { log } from "./observability/logger.js"
import { parseOptions } from "./plugin/options.js"

interface SessionMessagesResponse {
  data?: unknown
  error?: unknown
}

interface StableOpenCodeContext {
  client: {
    session: {
      messages(input: {
        path: { id: string }
        query?: { directory?: string }
      }): Promise<SessionMessagesResponse>
    }
  }
  directory: string
  worktree?: string
}

type PluginOptionsInput = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function readSessionMessages(ctx: StableOpenCodeContext, sessionID: string): Promise<unknown[]> {
  const response = await ctx.client.session.messages({
    path: { id: sessionID },
    query: { directory: ctx.directory },
  })
  if (response.error !== undefined && response.error !== null) {
    throw new Error("OpenCode session.messages returned an error")
  }
  if (!Array.isArray(response.data)) {
    throw new Error("OpenCode session.messages returned an invalid payload")
  }
  return response.data
}

function messageInfo(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return
  return isRecord(value.info) ? value.info : value
}

function messageParts(value: unknown): unknown[] {
  if (!isRecord(value)) return []
  if (Array.isArray(value.parts)) return value.parts
  if (Array.isArray(value.content)) return value.content
  return []
}

function hasCompactionPart(value: unknown): boolean {
  return messageParts(value).some((part) => isRecord(part) && part.type === "compaction")
}

/**
 * OpenCode keeps completed compaction markers/summaries in session history.
 * Jev should not repeatedly re-score tool traces already absorbed by a prior
 * native continuation summary. Start at the latest completed summary and
 * analyze only that baseline plus newer chronological material.
 */
export function currentCompactionWindow(messages: readonly unknown[]): unknown[] {
  const compactionUsers = new Set<string>()
  for (const message of messages) {
    const info = messageInfo(message)
    if (!info || info.role !== "user" || !hasCompactionPart(message)) continue
    if (typeof info.id === "string") compactionUsers.add(info.id)
  }

  let latestSummaryIndex = -1
  for (let index = 0; index < messages.length; index += 1) {
    const info = messageInfo(messages[index])
    if (!info || info.role !== "assistant" || info.summary !== true) continue
    if (info.error !== undefined && info.error !== null) continue
    if (!info.finish) continue
    if (typeof info.parentID !== "string" || !compactionUsers.has(info.parentID)) continue
    latestSummaryIndex = index
  }

  if (latestSummaryIndex < 0) return [...messages]
  return messages.slice(latestSummaryIndex)
}

function logRun(record: CompactionRunRecord): void {
  log({
    event: "compaction.run",
    status: record.status,
    reason: record.reason,
    summary: formatRun(record),
  })
}

/**
 * Stable OpenCode plugin entrypoint.
 *
 * OpenCode latest exposes experimental.session.compacting before its native
 * continuation summary is generated. Jev evaluates the current session once,
 * deterministic code maps probabilities to tool-evidence policy, and the
 * default guided-native mode appends compact guidance through output.context.
 *
 * Observe mode executes the same Jev decision path but leaves output untouched.
 */
export const JevCompactionPlugin = async (
  ctx: StableOpenCodeContext,
  rawOptions: PluginOptionsInput = {},
) => {
  const instanceId = randomUUID()
  const setupAt = new Date().toISOString()
  const options = parseOptions(rawOptions)
  const apiKey = process.env.TYPESAFE_API_KEY?.trim()
  const client = apiKey
    ? new JevClient({
        apiKey,
        baseUrl: options.baseUrl,
        model: options.model,
        timeoutMs: options.timeoutMs,
      })
    : undefined

  const runtime = {
    history: [] as CompactionRunRecord[],
    hookInvocations: 0,
    lastHookSessionID: null as string | null,
    lastHookInvocationAt: null as string | null,
  }

  log({
    event: "plugin.loaded",
    version: PLUGIN_VERSION,
    host: "opencode-latest",
    delivery: options.delivery,
    model: options.model,
    enabled: options.enabled,
    jevConfigured: Boolean(client),
    directory: ctx.directory,
    instanceId,
    setupAt,
  })

  return {
    "experimental.session.compacting": async (
      input: { sessionID: string },
      output: { context: string[]; prompt?: string },
    ) => {
      runtime.hookInvocations += 1
      runtime.lastHookSessionID = input.sessionID
      runtime.lastHookInvocationAt = new Date().toISOString()

      if (!options.enabled) {
        const stats = initialCompactionStats([], input.sessionID)
        stats.delivery = options.delivery
        stats.fallbackReason = "plugin-disabled"
        const record = makeRunRecord("disabled", "plugin-disabled", stats)
        runtime.history = appendHistory(runtime.history, record, options.historyLimit)
        logRun(record)
        return
      }

      if (!client) {
        const stats = initialCompactionStats([], input.sessionID)
        stats.delivery = options.delivery
        stats.fallbackReason = "missing-typesafe-api-key"
        const record = makeRunRecord("fallback", "missing-typesafe-api-key", stats)
        runtime.history = appendHistory(runtime.history, record, options.historyLimit)
        logRun(record)
        return
      }

      try {
        const messages = await readSessionMessages(ctx, input.sessionID)
        const analysisMessages = currentCompactionWindow(messages)
        const outcome = await compactTranscript(analysisMessages, client, options, undefined, input.sessionID)
        const stats = outcome.status === "ok" ? outcome.checkpoint.stats : outcome.stats
        let reason: string | null = outcome.status === "ok" ? null : outcome.reason

        if (outcome.status === "ok") {
          const guidance = buildNativeCompactionGuidance(stats)
          if (!guidance) {
            reason = "native-guidance-empty"
            stats.fallbackReason = reason
          } else {
            stats.nativeGuidanceChars = guidance.text.length
            stats.nativeGuidanceItems = guidance.items
            if (options.delivery === "guided-native") {
              output.context.push(guidance.text)
              reason = "native-guidance"
            } else {
              reason = "observe-only"
            }
          }
        }

        const record = makeRunRecord(outcome.status, reason, stats)
        runtime.history = appendHistory(runtime.history, record, options.historyLimit)
        logRun(record)
      } catch (error) {
        const stats = initialCompactionStats([], input.sessionID)
        stats.delivery = options.delivery
        stats.fallbackReason = "unexpected-hook-error"
        const record = makeRunRecord("error", "unexpected-hook-error", stats)
        runtime.history = appendHistory(runtime.history, record, options.historyLimit)
        log({
          event: "compaction.fallback",
          level: "error",
          reason: "unexpected-hook-error",
          type: error instanceof Error ? error.name : "Error",
        })
        logRun(record)
      }
    },
  }
}

export default JevCompactionPlugin
