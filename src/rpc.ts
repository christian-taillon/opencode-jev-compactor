import { Rpc } from "@opencode/plugin/rpc"

const emptyInput = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
} as const

const statusOutput = {
  type: "object" as const,
  properties: {
    enabled: { type: "boolean" as const },
    configuredEnabled: { type: "boolean" as const },
    overrideActive: { type: "boolean" as const },
    apiKeyConfigured: { type: "boolean" as const },
    model: { type: "string" as const },
    pluginVersion: { type: "string" as const },
    hookInvocations: { type: "integer" as const },
    lastHookInvocationAt: { type: ["string", "null"] as const },
    lastRun: { type: "string" as const },
    history: { type: "string" as const },
  },
  required: ["enabled", "configuredEnabled", "overrideActive", "apiKeyConfigured", "model", "pluginVersion", "hookInvocations", "lastHookInvocationAt", "lastRun", "history"],
  additionalProperties: false,
} as const

export const JevCompactionRpc = Rpc.define({
  id: "jev-compaction",
  methods: {
    status: { input: emptyInput, output: statusOutput },
    toggle: { input: emptyInput, output: statusOutput },
    resetEnabled: { input: emptyInput, output: statusOutput },
    setEnabled: {
      input: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
        additionalProperties: false,
      },
      output: statusOutput,
    },
  },
  events: {},
})
