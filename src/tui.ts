import { Plugin } from "@opencode/plugin/tui"
import { JevCompactionRpc } from "./rpc.js"

interface JevStatus {
  enabled: boolean
  configuredEnabled: boolean
  overrideActive: boolean
  apiKeyConfigured: boolean
  model: string
  pluginVersion: string
  hookInvocations: number
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
    typeof record.hookInvocations !== "number" ||
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
                      `Hook invocations (since load): ${status.hookInvocations}`,
                      `Last hook invocation: ${status.lastHookInvocationAt ?? "never"}`,
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
