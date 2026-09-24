export interface PluginOptions {
  enabled: boolean
  model: string
  keepThreshold: number
  preserveRecentMessages: number
  minReductionRatio: number
  /** Small result preview included in the single-pass chronological Jev state. */
  toolResultPreviewChars: number
  truncateHeadChars: number
  maxStateChars: number
  maxStateTokens: number
  maxRequestTokens: number
  maxConcurrentRequests: number
  timeoutMs: number
  enableCompareTool: boolean
  historyLimit: number
  jevInputCostPerMillionUsd: number
  baseUrl: string
}

export const DEFAULT_OPTIONS: PluginOptions = {
  enabled: true,
  model: "jev-latest",
  keepThreshold: 0.15,
  preserveRecentMessages: 6,
  minReductionRatio: 0.15,
  toolResultPreviewChars: 300,
  truncateHeadChars: 600,
  maxStateChars: 100_000,
  maxStateTokens: 24_000,
  maxRequestTokens: 30_000,
  maxConcurrentRequests: 2,
  timeoutMs: 6_000,
  enableCompareTool: true,
  historyLimit: 10,
  jevInputCostPerMillionUsd: 0.042,
  baseUrl: "https://api.typesafe.ai/v1/systemone",
}

function numberOption(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  integer = false,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  const normalized = integer ? Math.trunc(value) : value
  if (normalized < min || normalized > max) return fallback
  return normalized
}

function boolOption(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function stringOption(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback
}

export function parseOptions(input: Record<string, unknown>): PluginOptions {
  return {
    enabled: boolOption(input.enabled, DEFAULT_OPTIONS.enabled),
    model: stringOption(input.model, DEFAULT_OPTIONS.model),
    keepThreshold: numberOption(input.keepThreshold, DEFAULT_OPTIONS.keepThreshold, 0, 1),
    preserveRecentMessages: numberOption(
      input.preserveRecentMessages,
      DEFAULT_OPTIONS.preserveRecentMessages,
      0,
      100,
      true,
    ),
    minReductionRatio: numberOption(
      input.minReductionRatio,
      DEFAULT_OPTIONS.minReductionRatio,
      0,
      0.95,
    ),
    toolResultPreviewChars: numberOption(
      input.toolResultPreviewChars,
      DEFAULT_OPTIONS.toolResultPreviewChars,
      0,
      4_000,
      true,
    ),
    truncateHeadChars: numberOption(
      input.truncateHeadChars,
      DEFAULT_OPTIONS.truncateHeadChars,
      0,
      20_000,
      true,
    ),
    maxStateChars: numberOption(input.maxStateChars, DEFAULT_OPTIONS.maxStateChars, 5_000, 500_000, true),
    maxStateTokens: numberOption(input.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens, 2_000, 30_000, true),
    maxRequestTokens: numberOption(
      input.maxRequestTokens,
      DEFAULT_OPTIONS.maxRequestTokens,
      5_000,
      31_500,
      true,
    ),
    maxConcurrentRequests: numberOption(
      input.maxConcurrentRequests,
      DEFAULT_OPTIONS.maxConcurrentRequests,
      1,
      8,
      true,
    ),
    timeoutMs: numberOption(input.timeoutMs, DEFAULT_OPTIONS.timeoutMs, 250, 30_000, true),
    enableCompareTool: boolOption(input.enableCompareTool, DEFAULT_OPTIONS.enableCompareTool),
    historyLimit: numberOption(input.historyLimit, DEFAULT_OPTIONS.historyLimit, 1, 100, true),
    jevInputCostPerMillionUsd: numberOption(
      input.jevInputCostPerMillionUsd,
      DEFAULT_OPTIONS.jevInputCostPerMillionUsd,
      0,
      10,
    ),
    baseUrl: stringOption(input.baseUrl, DEFAULT_OPTIONS.baseUrl),
  }
}
