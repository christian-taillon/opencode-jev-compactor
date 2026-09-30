import { randomUUID } from "node:crypto"
import { compactTranscript, initialCompactionStats, PLUGIN_VERSION } from "./compaction/engine.js"
import { buildNativeCompactionGuidance } from "./compaction/guidance.js"
import type { CompactionRunRecord } from "./domain/types.js"
import { JevClient } from "./jev/client.js"
import { appendHistory, formatRun, makeRunRecord } from "./observability/history.js"
import { parseOptions } from "./plugin/options.js"

type LogLevel = "debug" | "info" | "warn" | "error"

interface OpenCodeSdkResponse<T> {
  data?: T
  error?: unknown
}

interface OpenCodeClient {
  session: {
    messages(input: {
      path: { id: string }
      query?: { directory?: string }
    }): Promise<OpenCodeSdkResponse<unknown> | unknown>
  }
  app?: {
    log(input: {
      body: {
        service: string
        level: LogLevel
        message: string
        extra?: Record<string, unknown>
      }
    }): Promise<unknown>
  }
}

interface OpenCodePluginInput {
  client: OpenCodeClient
  directory: string
}

interface CompactingOutput {
  context: string[]
  prompt?: string
}

const SERVICE = "opencode.jev-compaction"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sdkData(value: unknown): unknown {
  if (!isRecord(value)) return value
  if ("error" in value && value.error) throw new Error("OpenCode session.messages request failed")
  return "data" in value ? value.data : value
}

function messageArray(value: unknown): unknown[] {
  const data = sdkData(value)
  if (!Array.isArray(data)) throw new Error("OpenCode session.messages returned an unexpected payload")
  return data
}

export async function JevCompactionPlugin(
  input: OpenCodePluginInput,
  rawOptions: Record<string, unknown> = {},
) {
  const options = parseOptions(rawOptions)
  const instanceId = randomUUID()
  const setupAt = new Date().toISOString()
  const apiKey = process.env.TYPESAFE_API_KEY?.trim()
  const jev = apiKey
    ? new JevClient({ apiKey, baseUrl: options.baseUrl, model: options.model, timeoutMs: options.timeoutMs })
    : undefined

  const runtime = {
    hookInvocations: 0,
    history: [] as CompactionRunRecord[],
  }

  const emit = async (
    level: LogLevel,
    message: string,
    extra: Record<string, unknown> = {},
  ) => {
    const payload = {
      pluginVersion: PLUGIN_VERSION,
      instanceId,
      setupAt,
      directory: input.directory,
      delivery: options.delivery,
      ...extra,
    }
    try {
      if (input.client.app?.log) {
        await input.client.app.log({
          body: {
            service: SERVICE,
            level,
            message,
            extra: payload,
          },
        })
        return
      }
    } catch {
      // Logging must never affect compaction.
    }
    const line = JSON.stringify({ service: SERVICE, level, message, ...payload })
    if (level === "error") console.error(line)
    else if (level === "warn") console.warn(line)
    else console.log(line)
  }

  const record = async (
    status: CompactionRunRecord["status"],
    reason: string | null,
    stats: CompactionRunRecord["stats"],
  ) => {
    const next = makeRunRecord(status, reason, stats)
    runtime.history = appendHistory(runtime.history, next, options.historyLimit)
    await emit(status === "error" ? "error" : status === "fallback" ? "warn" : "info", "compaction decision", {
      status,
      reason,
      run: formatRun(next),
    })
  }

  await emit("info", "plugin loaded", {
    enabled: options.enabled,
    apiKeyConfigured: Boolean(jev),
  })

  return {
    "experimental.session.compacting": async (
      event: { sessionID: string },
      output: CompactingOutput,
    ) => {
      runtime.hookInvocations += 1

      if (!options.enabled) {
        const stats = initialCompactionStats([], event.sessionID)
        stats.delivery = options.delivery
        stats.fallbackReason = "plugin-disabled"
        await record("disabled", "plugin-disabled", stats)
        return
      }

      if (!jev) {
        const stats = initialCompactionStats([], event.sessionID)
        stats.delivery = options.delivery
        stats.fallbackReason = "missing-typesafe-api-key"
        await record("fallback", "missing-typesafe-api-key", stats)
        return
      }

      let messages: unknown[]
      try {
        const response = await input.client.session.messages({
          path: { id: event.sessionID },
          query: { directory: input.directory },
        })
        messages = messageArray(response)
      } catch (error) {
        const stats = initialCompactionStats([], event.sessionID)
        stats.delivery = options.delivery
        stats.fallbackReason = "session-messages-unavailable"
        await record("fallback", "session-messages-unavailable", stats)
        await emit("warn", "failed to read session messages", {
          sessionID: event.sessionID,
          errorType: error instanceof Error ? error.name : "Error",
        })
        return
      }

      try {
        const outcome = await compactTranscript(messages, jev, options, undefined, event.sessionID)
        const stats = outcome.status === "ok" ? outcome.checkpoint.stats : outcome.stats
        if (outcome.status !== "ok") {
          await record(outcome.status, outcome.reason, stats)
          return
        }

        const guidance = buildNativeCompactionGuidance(stats)
        if (!guidance) {
          stats.fallbackReason = "native-guidance-empty"
          await record("fallback", "native-guidance-empty", stats)
          return
        }

        stats.nativeGuidanceChars = guidance.text.length
        stats.nativeGuidanceItems = guidance.items

        if (options.delivery === "guided-native") {
          // OpenCode appends output.context after its default compaction prompt.
          // The serialized conversation prefix is therefore left untouched.
          output.context.push(guidance.text)
          await record("ok", "native-guidance", stats)
          return
        }

        // Observe mode runs the full Jev pipeline but intentionally leaves the
        // native compaction prompt unchanged.
        await record("ok", "observe-only", stats)
      } catch (error) {
        const stats = initialCompactionStats(messages, event.sessionID)
        stats.delivery = options.delivery
        stats.fallbackReason = "unexpected-hook-error"
        await record("error", "unexpected-hook-error", stats)
        await emit("error", "unexpected compaction hook error", {
          sessionID: event.sessionID,
          errorType: error instanceof Error ? error.name : "Error",
        })
      }
    },
  }
}

export default JevCompactionPlugin
