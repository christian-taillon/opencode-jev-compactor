import { Plugin } from "@opencode/plugin/tui"
import { JevCompactionRpc } from "./rpc.js"

interface JevStatus {
  enabled: boolean
  configuredEnabled: boolean
  overrideActive: boolean
  apiKeyConfigured: boolean
  model: string
  pluginVersion: string
  processPid: number
  instanceId: string
  setupAt: string
  locationDirectory: string
  locationWorkspaceID: string | null
  modelRequestCount: number
  lastModelRequestSessionID: string | null
  lastModelRequestAt: string | null
  hookInvocations: number
  lastHookSessionID: string | null
  lastHookInvocationAt: string | null
  lastRun: string
  history: string
}

function parseStatus(value: unknown): JevStatus {
  if (typeof value !== "object" || value === null) throw new Error("Invalid Jev status response")
  const record = value as Record<string, unknown>
  if (
    typeof record.enabled !== "boolean" ||
    typeof record.configuredEnabled !== "boolean" ||
    typeof record.overrideActive !== "boolean" ||
    typeof record.apiKeyConfigured !== "boolean" ||
    typeof record.model !== "string" ||
    typeof record.pluginVersion !== "string" ||
    !Number.isInteger(record.processPid) ||
    typeof record.instanceId !== "string" ||
    typeof record.setupAt !== "string" ||
    typeof record.locationDirectory !== "string" ||
    (record.locationWorkspaceID !== null && typeof record.locationWorkspaceID !== "string") ||
    !Number.isInteger(record.modelRequestCount) ||
    (record.lastModelRequestSessionID !== null && typeof record.lastModelRequestSessionID !== "string") ||
    (record.lastModelRequestAt !== null && typeof record.lastModelRequestAt !== "string") ||
    typeof record.hookInvocations !== "number" ||
    (record.lastHookSessionID !== null && typeof record.lastHookSessionID !== "string") ||
    (record.lastHookInvocationAt !== null && typeof record.lastHookInvocationAt !== "string") ||
    typeof record.lastRun !== "string" ||
    typeof record.history !== "string"
  ) throw new Error("Invalid Jev status response")
  return record as unknown as JevStatus
}

export default Plugin.define({
  id: "opencode.jev-compaction.tui",
  setup(context) {
    const jev = context.client.rpc(JevCompactionRpc)

    return context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 10,
          commands: [
            {
              id: "jev-compaction.status",
              title: "Jev compaction status",
              group: "Jev Compaction",
              palette: true,
              slash: { name: "jev-status", aliases: ["jev"] },
              suggested: true,
              enabled: () => true,
              run: async () => {
                try {
                  const status = parseStatus(await jev.status({}))
                  const dialog = context.ui.dialog.alert({
                    title: `Jev Compaction: ${status.enabled ? "ON" : "OFF"}`,
                    message: [
                      `Model: ${status.model}`,
                      `Loaded plugin: ${status.pluginVersion}`,
                      `Process PID: ${status.processPid}`,
                      `Plugin instance: ${status.instanceId}`,
                      `Plugin setup: ${status.setupAt}`,
                      `Plugin location: ${status.locationDirectory}`,
                      `Plugin workspace: ${status.locationWorkspaceID ?? "none"}`,
                      `Compaction model requests (since load): ${status.modelRequestCount}`,
                      `Last compaction model request: ${status.lastModelRequestAt ?? "never"} (session ${status.lastModelRequestSessionID ?? "none"})`,
                      `Compaction hook invocations (since load): ${status.hookInvocations}`,
                      `Last compaction hook invocation: ${status.lastHookInvocationAt ?? "never"} (session ${status.lastHookSessionID ?? "none"})`,
                      `Configured default: ${status.configuredEnabled ? "ON" : "OFF"}`,
                      `Runtime override: ${status.overrideActive ? "active" : "none"}`,
                      `API key: ${status.apiKeyConfigured ? "configured" : "missing"}`,
                      "",
                      "Last recorded run (historical)",
                      status.lastRun,
                      "",
                      "Previous runs",
                      status.history,
                    ].join("\n"),
                  })
                  context.ui.dialog.set({ size: "xlarge" })
                  await dialog
                } catch (error) {
                  context.ui.toast.show({ title: "Jev Compaction", message: error instanceof Error ? error.message : "Status unavailable", variant: "error" })
                }
              },
            },
            {
              id: "jev-compaction.reset",
              title: "Reset Jev compaction to configured state",
              group: "Jev Compaction",
              palette: true,
              slash: { name: "jev-reset" },
              enabled: () => true,
              run: async () => {
                try {
                  const status = parseStatus(await jev.resetEnabled({}))
                  context.ui.toast.show({
                    title: "Jev Compaction",
                    message: `Runtime override cleared. Using configured value: ${status.enabled ? "ON" : "OFF"}.`,
                    variant: "success",
                    duration: 3500,
                  })
                } catch (error) {
                  context.ui.toast.show({ title: "Jev Compaction", message: error instanceof Error ? error.message : "Reset failed", variant: "error" })
                }
              },
            },
            {
              id: "jev-compaction.toggle",
              title: "Toggle Jev compaction",
              group: "Jev Compaction",
              palette: true,
              slash: { name: "jev-toggle" },
              enabled: () => true,
              run: async () => {
                try {
                  const status = parseStatus(await jev.toggle({}))
                  context.ui.toast.show({
                    title: "Jev Compaction",
                    message: status.enabled ? "Enabled. Future native compactions use Jev." : "Disabled. Future native compactions fall through to OpenCode.",
                    variant: "success",
                    duration: 3500,
                  })
                } catch (error) {
                  context.ui.toast.show({ title: "Jev Compaction", message: error instanceof Error ? error.message : "Toggle failed", variant: "error" })
                }
              },
            },
          ],
          bindings: ["jev-compaction.status", "jev-compaction.toggle", "jev-compaction.reset"],
        }))
        return null
      },
    })
  },
})
