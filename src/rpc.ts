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
    processPid: { type: "integer" as const },
    instanceId: { type: "string" as const },
    setupAt: { type: "string" as const },
    locationDirectory: { type: "string" as const },
    locationWorkspaceID: { type: ["string", "null"] as const },
    modelRequestCount: { type: "integer" as const },
    lastModelRequestSessionID: { type: ["string", "null"] as const },
    lastModelRequestAt: { type: ["string", "null"] as const },
    hookInvocations: { type: "integer" as const },
    lastHookSessionID: { type: ["string", "null"] as const },
    lastHookInvocationAt: { type: ["string", "null"] as const },
    lastRun: { type: "string" as const },
    history: { type: "string" as const },
  },
  required: ["enabled", "configuredEnabled", "overrideActive", "apiKeyConfigured", "model", "pluginVersion", "processPid", "instanceId", "setupAt", "locationDirectory", "locationWorkspaceID", "modelRequestCount", "lastModelRequestSessionID", "lastModelRequestAt", "hookInvocations", "lastHookSessionID", "lastHookInvocationAt", "lastRun", "history"],
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
