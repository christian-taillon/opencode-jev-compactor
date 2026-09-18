import type { JsonValue } from "../domain/types.js"
import { parseJevResponse } from "./parse.js"
import type { JevBatchResult, JevQuestion, JevRequest } from "./types.js"

export interface JevClientOptions {
  apiKey: string
  baseUrl: string
  model: string
  timeoutMs: number
}

export class JevHttpError extends Error {
  override readonly name = "JevHttpError"
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

function abortError(): Error {
  const error = new Error("Jev request aborted")
  error.name = "AbortError"
  return error
}

function combinedSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error("Jev request timed out")), timeoutMs)
  const onAbort = () => controller.abort(parent?.reason ?? abortError())
  if (parent) {
    if (parent.aborted) onAbort()
    else parent.addEventListener("abort", onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      parent?.removeEventListener("abort", onAbort)
    },
  }
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500
}

async function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
  const delayMs = 100 * (2 ** attempt)
  if (signal?.aborted) throw signal.reason ?? abortError()
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(signal?.reason ?? abortError())
    }
    const finish = () => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }
    const timer = setTimeout(finish, delayMs)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export class JevClient {
  constructor(private readonly options: JevClientOptions) {}

  async ask(state: JsonValue, questions: Record<string, JevQuestion>, signal?: AbortSignal): Promise<JevBatchResult> {
    const started = performance.now()
    const body: JevRequest = { model: this.options.model, state, questions }
    let lastError: unknown

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal?.aborted) throw signal.reason ?? abortError()
      const scoped = combinedSignal(signal, this.options.timeoutMs)
      try {
        const response = await fetch(this.options.baseUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: scoped.signal,
        })
        if (!response.ok) {
          const error = new JevHttpError(`TypeSafe System One returned HTTP ${response.status}`, response.status)
          if (attempt < 2 && retryable(response.status)) {
            lastError = error
            await backoff(attempt, signal)
            continue
          }
          throw error
        }
        const raw: unknown = await response.json()
        return {
          response: parseJevResponse(raw, questions),
          latencyMs: Math.round(performance.now() - started),
        }
      } catch (error) {
        lastError = error
        if (attempt < 2 && error instanceof JevHttpError && retryable(error.status ?? 0)) continue
        throw error
      } finally {
        scoped.cleanup()
      }
    }
    throw lastError instanceof Error ? lastError : new JevHttpError("TypeSafe System One request failed")
  }
}
