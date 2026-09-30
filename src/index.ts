import { randomUUID } from "node:crypto"
import { compactTranscript, initialCompactionStats, PLUGIN_VERSION } from "./compaction/engine.js"
import { buildNativeCompactionGuidance } from "./compaction/guidance.js"
import type { CompactionRunRecord } from "./domain/types.js"
import { JevClient } from "./jev/client.js"
import { appendHistory, formatRun, makeRunRecord } from "./observability/history.js"
import { log } from "./observability/logger.js"
import { parseOptions } from "./plugin/options.js"
import { loadRuntimeState, runtimeStatePath, saveRuntimeState } from "./plugin/state.js"

interface SessionMessagesResponse {
  data?: unknown
  error?: unknown
}

interface OpenCodePluginInput {
  client: {
    session: {
      messages(input: { sessionID: string }): Promise<SessionMessagesResponse>
    }
  }
  directory: string
  worktree: string
  project?: { id?: string }
}

interface CompactionHookOutput {
  context: string[]
  prompt?: string
}

type PluginOptionsInput = Record<string, unknown>

function messageArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function statusLog(
  instanceId: string,
  directory: string,
  delivery: string,
  record: CompactionRunRecord,
): void {
  log({
    event: "compaction.status",
    instanceId,
    directory,
    delivery,
    status: record.status,
    reason: record.reason,
    summary: formatRun(record),
    stateFile: runtimeStatePath(),
  })
}

/**
 * OpenCode latest/stable plugin adapter.
 *
 * Uses the public experimental.session.compacting hook. The historical
 * transcript is fetched through the OpenCode client, Jev makes one decision
 * stage over tool evidence, and guided-native appends only compaction context.
 * Existing messages are never rewritten, preserving the provider-cache prefix.
 */
export default async function JevCompactionPlugin(
  ctx: OpenCodePluginInput,
  rawOptions: PluginOptionsInput = {},
) {
  const instanceId = randomUUID()
  const options = parseOptions(rawOptions)
  const apiKey = process.env.TYPESAFE_API_KEY?.trim()
  const persisted = await loadRuntimeState()
  let history = (persisted.history ?? []).slice(-options.historyLimit)

  const client = apiKey
    ? new JevClient({
        apiKey,
        baseUrl: options.baseUrl,
        model: options.model,
        timeoutMs: options.timeoutMs,
      })
    : undefined

  let persistChain: Promise<void> = Promise.resolve()
  const persist = (record: CompactionRunRecord): Promise<void> => {
    const task = persistChain
      .catch(() => undefined)
      .then(async () => {
        history = appendHistory(history, record, options.historyLimit)
        await saveRuntimeState({ history })
        statusLog(instanceId, ctx.directory, options.delivery, record)
      })
    persistChain = task
    return task
  }

  log({
    event: "plugin.loaded",
    version: PLUGIN_VERSION,
    instanceId,
    directory: ctx.directory,
    worktree: ctx.worktree,
    delivery: options.delivery,
    enabled: options.enabled,
    model: options.model,
    jevConfigured: Boolean(client),
    stateFile: runtimeStatePath(),
  })

  return {
    "experimental.session.compacting": async (
      input: { sessionID: string },
      output: CompactionHookOutput,
    ) => {
      if (!options.enabled) {
        const stats = initialCompactionStats([], input.sessionID)
        stats.delivery = options.delivery
        stats.fallbackReason = "plugin-disabled"
        await persist(makeRunRecord("disabled", "plugin-disabled", stats))
        return
      }

      if (!client) {
        const stats = initialCompactionStats([], input.sessionID)
        stats.delivery = options.delivery
        stats.fallbackReason = "missing-typesafe-api-key"
        await persist(makeRunRecord("fallback", "missing-typesafe-api-key", stats))
        return
      }

      let rawMessages: readonly unknown[]
      try {
        const response = await ctx.client.session.messages({ sessionID: input.sessionID })
        if (response.error !== undefined) throw new Error("session-messages-error")
        rawMessages = messageArray(response.data)
      } catch (error) {
        const stats = initialCompactionStats([], input.sessionID)
        stats.delivery = options.delivery
        stats.fallbackReason = "session-messages-unavailable"
        log({
          event: "compaction.fallback",
          level: "warn",
          reason: "session-messages-unavailable",
          type: error instanceof Error ? error.name : "Error",
        })
        await persist(makeRunRecord("fallback", "session-messages-unavailable", stats))
        return
      }

      const outcome = await compactTranscript(rawMessages, client, options, undefined, input.sessionID)
      const stats = outcome.status === "ok" ? outcome.checkpoint.stats : outcome.stats

      if (outcome.status !== "ok") {
        await persist(makeRunRecord(outcome.status, outcome.reason, stats))
        return
      }

      const guidance = buildNativeCompactionGuidance(stats)
      if (!guidance) {
        stats.fallbackReason = "native-guidance-empty"
        await persist(makeRunRecord("fallback", "native-guidance-empty", stats))
        return
      }

      stats.nativeGuidanceChars = guidance.text.length
      stats.nativeGuidanceItems = guidance.items

      if (options.delivery === "guided-native") {
        output.context.push(guidance.text)
        await persist(makeRunRecord("ok", "native-guidance", stats))
        return
      }

      // Observe mode intentionally leaves OpenCode's compaction request
      // untouched while retaining the projected Jev decisions and cost.
      await persist(makeRunRecord("ok", "observe-only", stats))
    },
  }
}
