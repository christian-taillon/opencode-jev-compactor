import { Plugin } from "@opencode/plugin"
import { randomUUID } from "node:crypto"
import { compactTranscript, initialCompactionStats, PLUGIN_VERSION } from "./compaction/engine.js"
import { buildNativeCompactionGuidance, nativeGuidanceMessage } from "./compaction/guidance.js"
import type { CompactionRunRecord } from "./domain/types.js"
import { JevClient } from "./jev/client.js"
import { appendHistory, formatHistory, formatRun, makeRunRecord } from "./observability/history.js"
import { toJson } from "./observability/json.js"
import { log } from "./observability/logger.js"
import { parseOptions } from "./plugin/options.js"
import { JevCompactionRpc } from "./rpc.js"
import { makeCompareTool } from "./tools/register.js"

interface Registration { dispose(): Promise<void> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function storedEnabled(value: unknown): boolean | undefined {
  if (!isRecord(value)) return undefined
  return typeof value.enabled === "boolean" ? value.enabled : undefined
}

function coerceHistory(value: unknown): CompactionRunRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is CompactionRunRecord => {
    if (!isRecord(entry) || typeof entry.at !== "string" || !isRecord(entry.stats)) return false
    return entry.status === "ok" || entry.status === "fallback" || entry.status === "error" || entry.status === "disabled"
  })
}

function eventAbortSignal(event: unknown): AbortSignal | undefined {
  if (!isRecord(event)) return undefined
  return event.signal instanceof AbortSignal ? event.signal : undefined
}

export default Plugin.define({
  id: "opencode.jev-compaction",
  async setup(ctx) {
    const instanceId = randomUUID()
    const setupAt = new Date().toISOString()
    const options = parseOptions(ctx.options)
    const apiKey = process.env.TYPESAFE_API_KEY?.trim()
    const registrations: Registration[] = []
    const client = apiKey
      ? new JevClient({ apiKey, baseUrl: options.baseUrl, model: options.model, timeoutMs: options.timeoutMs })
      : undefined

    const storedOverride = storedEnabled(await ctx.storage.get("settings"))
    const runtime = {
      enabled: storedOverride ?? options.enabled,
      overrideActive: storedOverride !== undefined,
      history: coerceHistory(await ctx.storage.get("history")).slice(-options.historyLimit),
      modelRequestCount: 0,
      lastModelRequestSessionID: null as string | null,
      lastModelRequestAt: null as string | null,
      hookInvocations: 0,
      lastHookSessionID: null as string | null,
      lastHookInvocationAt: null as string | null,
    }

    const persistRecord = async (record: CompactionRunRecord) => {
      runtime.history = appendHistory(runtime.history, record, options.historyLimit)
      await Promise.all([
        ctx.storage.set("last-run", toJson(record)),
        ctx.storage.set("history", toJson(runtime.history)),
      ])
    }

    const status = () => {
      const last = runtime.history.at(-1)
      return {
        enabled: runtime.enabled,
        configuredEnabled: options.enabled,
        overrideActive: runtime.overrideActive,
        apiKeyConfigured: Boolean(client),
        delivery: options.delivery,
        model: options.model,
        pluginVersion: PLUGIN_VERSION,
        processPid: process.pid,
        instanceId,
        setupAt,
        locationDirectory: ctx.location.directory,
        locationWorkspaceID: ctx.location.workspaceID ?? null,
        modelRequestCount: runtime.modelRequestCount,
        lastModelRequestSessionID: runtime.lastModelRequestSessionID,
        lastModelRequestAt: runtime.lastModelRequestAt,
        hookInvocations: runtime.hookInvocations,
        lastHookSessionID: runtime.lastHookSessionID,
        lastHookInvocationAt: runtime.lastHookInvocationAt,
        lastRun: last ? formatRun(last) : "No compaction run recorded yet.",
        history: formatHistory(runtime.history.slice(0, -1)),
      }
    }

    registrations.push(await ctx.rpc.register(JevCompactionRpc, {
      status: async () => status(),
      toggle: async () => {
        runtime.enabled = !runtime.enabled
        runtime.overrideActive = true
        await ctx.storage.set("settings", toJson({ enabled: runtime.enabled }))
        log({ event: "runtime.toggle", enabled: runtime.enabled })
        return status()
      },
      resetEnabled: async () => {
        runtime.enabled = options.enabled
        runtime.overrideActive = false
        await ctx.storage.set("settings", toJson({}))
        log({ event: "runtime.reset-enabled", enabled: runtime.enabled })
        return status()
      },
      setEnabled: async (input) => {
        const requested = isRecord(input) && typeof input.enabled === "boolean" ? input.enabled : options.enabled
        runtime.enabled = requested
        runtime.overrideActive = true
        await ctx.storage.set("settings", toJson({ enabled: runtime.enabled }))
        log({ event: "runtime.set-enabled", enabled: runtime.enabled })
        return status()
      },
    }))

    registrations.push(await ctx.session.hook("model.request", (event) => {
      if (event.kind !== "compaction") return
      runtime.modelRequestCount += 1
      runtime.lastModelRequestSessionID = event.sessionID
      runtime.lastModelRequestAt = new Date().toISOString()
    }))

    registrations.push(await ctx.session.hook("compaction", async (event) => {
      runtime.hookInvocations += 1
      runtime.lastHookSessionID = event.sessionID
      runtime.lastHookInvocationAt = new Date().toISOString()
      if (event.result !== undefined) {
        const stats = initialCompactionStats(event.messages, event.sessionID)
        stats.delivery = options.delivery
        stats.fallbackReason = "preexisting-compaction-result"
        try { await persistRecord(makeRunRecord("fallback", "preexisting-compaction-result", stats)) } catch { /* observability only */ }
        log({ event: "compaction.skipped", level: "warn", reason: "preexisting-compaction-result", sessionID: event.sessionID })
        return
      }
      if (!runtime.enabled) {
        const stats = initialCompactionStats(event.messages, event.sessionID)
        stats.delivery = options.delivery
        stats.fallbackReason = "plugin-disabled"
        try { await persistRecord(makeRunRecord("disabled", "plugin-disabled", stats)) } catch { /* observability only */ }
        return
      }
      if (!client) {
        const stats = initialCompactionStats(event.messages, event.sessionID)
        stats.delivery = options.delivery
        stats.fallbackReason = "missing-typesafe-api-key"
        try { await persistRecord(makeRunRecord("fallback", "missing-typesafe-api-key", stats)) } catch { /* observability only */ }
        log({ event: "compaction.fallback", level: "warn", reason: "missing-typesafe-api-key" })
        return
      }

      try {
        const outcome = await compactTranscript(event.messages, client, options, eventAbortSignal(event), event.sessionID)
        const stats = outcome.status === "ok" ? outcome.checkpoint.stats : outcome.stats
        let recordReason: string | null = outcome.status === "ok" ? null : outcome.reason
        if (outcome.status === "ok") {
          if (options.delivery === "guided-native") {
            const guidance = buildNativeCompactionGuidance(stats)
            if (!guidance) {
              recordReason = "native-guidance-empty"
              stats.fallbackReason = recordReason
              log({ event: "compaction.fallback", level: "warn", reason: recordReason })
            } else {
              stats.nativeGuidanceChars = guidance.text.length
              stats.nativeGuidanceItems = guidance.items
              // Copy-on-write append: every existing message remains in the same order and
              // unchanged, so provider prefix caching can still match through the old history.
              event.messages = [...event.messages, nativeGuidanceMessage(guidance.text)]
              recordReason = "native-guidance"
              log({
                event: "compaction.guidance",
                delivery: options.delivery,
                guidanceItems: guidance.items,
                guidanceChars: guidance.text.length,
                guidanceDropped: guidance.dropped,
                guidanceProvenanceOnly: guidance.provenanceOnly,
                toolsScored: stats.toolsScored,
                semanticReductionActions: stats.semanticReductionActions,
                semanticRemovedFraction: stats.semanticRemovedFraction,
                jevRequests: stats.jevRequests,
                jevInputTokens: stats.jevInputTokens,
                estimatedJevCostUsd: stats.estimatedJevCostUsd,
                latencyMs: stats.jevLatencyMs,
              })
            }
          } else {
            event.result = {
              summary: outcome.checkpoint.summary,
              metadata: {
                plugin: "opencode.jev-compaction",
                version: PLUGIN_VERSION,
                model: options.model,
                delivery: options.delivery,
                policy: "single-pass-deterministic-tool-policy-v7",
                stats,
              },
            }
            log({
              event: "compaction.complete",
              delivery: options.delivery,
              toolsScored: stats.toolsScored,
              toolsKeptFull: stats.toolsKeptFull,
              toolsTruncated: stats.toolsTruncated,
              toolsDropped: stats.toolsDropped,
              textsKept: stats.textsKept,
              textsDropped: stats.textsDropped,
              semanticReductionActions: stats.semanticReductionActions,
              semanticRemovedFraction: stats.semanticRemovedFraction,
              jevRequests: stats.jevRequests,
              jevInputTokens: stats.jevInputTokens,
              estimatedJevCostUsd: stats.estimatedJevCostUsd,
              latencyMs: stats.jevLatencyMs,
              removedFraction: stats.removedFraction,
            })
          }
        } else {
          log({ event: "compaction.fallback", level: "warn", reason: outcome.reason, jevRequests: stats.jevRequests, latencyMs: stats.jevLatencyMs })
        }
        try {
          await persistRecord(makeRunRecord(outcome.status, recordReason, stats))
        } catch (error) {
          log({ event: "storage.error", level: "warn", type: error instanceof Error ? error.name : "Error" })
        }
      } catch (error) {
        log({ event: "compaction.fallback", level: "error", reason: "unexpected-hook-error", type: error instanceof Error ? error.name : "Error" })
      }
    }))

    if (client && options.enableCompareTool) {
      registrations.push(await ctx.tool.transform((editor) => editor.add(makeCompareTool(client))))
    }

    log({
      event: "plugin.loaded",
      version: PLUGIN_VERSION,
      model: options.model,
      delivery: options.delivery,
      enabled: runtime.enabled,
      configuredEnabled: options.enabled,
      overrideActive: runtime.overrideActive,
      compareTool: Boolean(client && options.enableCompareTool),
      jevConfigured: Boolean(client),
    })

    return async () => {
      for (const registration of [...registrations].reverse()) {
        try { await registration.dispose() } catch { /* OpenCode also owns scoped disposal. */ }
      }
    }
  },
})
