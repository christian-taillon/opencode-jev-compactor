import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { CompactionRunRecord } from "../domain/types.js"
import { toJson } from "../observability/json.js"

interface PersistedState {
  enabledOverride?: boolean
  history?: CompactionRunRecord[]
}

function statePath(): string {
  const base = process.env.XDG_STATE_HOME?.trim()
    || join(process.env.HOME?.trim() || process.cwd(), ".local", "state")
  return join(base, "opencode", "jev-compaction", "state.json")
}

function validRecord(value: unknown): value is CompactionRunRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.at === "string"
    && (record.status === "ok" || record.status === "fallback" || record.status === "error" || record.status === "disabled")
    && typeof record.stats === "object"
    && record.stats !== null
}

export async function loadRuntimeState(): Promise<PersistedState> {
  try {
    const raw = JSON.parse(await readFile(statePath(), "utf8")) as unknown
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
    const record = raw as Record<string, unknown>
    return {
      ...(typeof record.enabledOverride === "boolean" ? { enabledOverride: record.enabledOverride } : {}),
      ...(Array.isArray(record.history) ? { history: record.history.filter(validRecord) } : {}),
    }
  } catch {
    return {}
  }
}

export async function saveRuntimeState(value: PersistedState): Promise<void> {
  const path = statePath()
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temporary, JSON.stringify(toJson(value), null, 2), { encoding: "utf8", mode: 0o600 })
  await rename(temporary, path)
}

export function runtimeStatePath(): string {
  return statePath()
}
