// otel.guard — positive command/URL allowlist.
//
// A complement to the negative `deny` rules in the policy file: when a tool has
// an allowlist entry, only matching commands/URLs proceed. Applies to the
// structured arguments captured by `tool.execute.before`, so it sees the real
// command rather than the lossy permission `resources` string. Off by default:
// the file is optional and a missing/invalid file leaves the guard passive.

import { readFileSync, watch } from "node:fs"
import { createHash } from "node:crypto"
import { canonicalJson } from "./canonical-json.ts"
import { toolInputText } from "./tool-state.ts"

/** Rule for one tool: either `command_prefixes` or `url_prefixes` may be set. */
export type AllowlistRule = {
  tool: string
  commandPrefixes: string[]
  urlPrefixes: string[]
}

/** Normalized allowlist document. Only tools with an entry are constrained. */
export type ToolAllowlist = {
  version: string
  versionSha256: string
  rules: Map<string, AllowlistRule>
  sourcePath: string
  loadedAt: number
}

/** Outcome of checking a tool call against the allowlist. */
export type AllowlistVerdict =
  | { kind: "not_applicable" }
  | { kind: "allowed"; matchedPrefix: string }
  | { kind: "denied"; reason: string }

/** Hot-reloadable holder with last-good retention (same contract as policy). */
export type AllowlistHolder = {
  allowlist: ToolAllowlist | null
  reload: () => ToolAllowlist | null
}

const MAX_PREFIXES = 256
const MAX_PREFIX_LEN = 2048

/** Normalize a raw allowlist document, throwing on malformed structures. */
export function normalizeAllowlist(doc: unknown, sourcePath = ""): ToolAllowlist {
  if (!doc || typeof doc !== "object") throw new TypeError("allowlist root must be an object")
  const root = doc as { version?: unknown; tools?: unknown }
  if (!root.tools || typeof root.tools !== "object" || Array.isArray(root.tools)) {
    throw new TypeError("allowlist.tools must be an object")
  }
  const rules = new Map<string, AllowlistRule>()
  for (const [rawTool, rawRule] of Object.entries(root.tools)) {
    const tool = rawTool.trim().toLowerCase()
    if (!tool) throw new TypeError("allowlist tool name must be non-empty")
    if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
      throw new TypeError(`allowlist.tools.${rawTool} must be an object`)
    }
    const entry = rawRule as Record<string, unknown>
    const commandPrefixes = normalizePrefixes(entry["command_prefixes"], `allowlist.tools.${rawTool}.command_prefixes`)
    const urlPrefixes = normalizePrefixes(entry["url_prefixes"], `allowlist.tools.${rawTool}.url_prefixes`)
    if (!commandPrefixes.length && !urlPrefixes.length) {
      throw new TypeError(`allowlist.tools.${rawTool} needs at least one prefix`)
    }
    rules.set(tool, { tool, commandPrefixes, urlPrefixes })
  }
  const sha256 = createHash("sha256").update(canonicalJson(doc) ?? "null").digest("hex")
  return {
    version: typeof root.version === "string" ? root.version : "",
    versionSha256: `sha256:${sha256}`,
    rules,
    sourcePath,
    loadedAt: Date.now(),
  }
}

function normalizePrefixes(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  if (value.length > MAX_PREFIXES) throw new TypeError(`${label} exceeds ${MAX_PREFIXES} entries`)
  const out: string[] = []
  for (const prefix of value) {
    if (typeof prefix !== "string" || !prefix.length) throw new TypeError(`${label} entries must be non-empty strings`)
    if (prefix.length > MAX_PREFIX_LEN) throw new TypeError(`${label} entry exceeds ${MAX_PREFIX_LEN} characters`)
    out.push(prefix.toLowerCase())
  }
  return out
}

/** Load and normalize an allowlist from disk. */
export function loadAllowlist(path: string): ToolAllowlist {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (e) {
    throw new Error(`allowlist unreadable: ${path}: ${e instanceof Error ? e.message : e}`)
  }
  return normalizeAllowlist(JSON.parse(raw) as unknown, path)
}

/**
 * Check a tool call against the allowlist. Tools with no entry are not subject
 * to allowlisting; `not_applicable` also covers calls with no recognised text.
 */
export function checkAllowlist(allowlist: ToolAllowlist | null, tool: string, input: unknown): AllowlistVerdict {
  if (!allowlist) return { kind: "not_applicable" }
  const rule = allowlist.rules.get(tool.toLowerCase())
  if (!rule) return { kind: "not_applicable" }
  const text = toolInputText(tool, input)
  if (text === null) return { kind: "denied", reason: `${tool}: no allowlist-eligible argument found` }
  const lower = text.toLowerCase()
  const prefixes = FETCH_LIKE.has(tool.toLowerCase()) ? rule.urlPrefixes : rule.commandPrefixes
  const usable = prefixes.length ? prefixes : [...rule.commandPrefixes, ...rule.urlPrefixes]
  for (const prefix of usable) {
    if (lower.startsWith(prefix)) return { kind: "allowed", matchedPrefix: prefix }
  }
  return { kind: "denied", reason: `${tool}: argument does not match any allowed prefix` }
}

/** Tools checked against `url_prefixes` first when both lists are present. */
const FETCH_LIKE: ReadonlySet<string> = new Set(["webfetch", "fetch", "http", "curl"])

/**
 * Load an allowlist and keep it fresh via a non-persistent watcher. A missing or
 * invalid file leaves the holder at `null` (passive) and reports through onError.
 */
export function makeAllowlistHolder(path: string, onError: (e: unknown) => void = () => {}): AllowlistHolder {
  const holder: AllowlistHolder = { allowlist: null, reload: () => null }
  const reload = () => {
    try {
      holder.allowlist = loadAllowlist(path)
      return holder.allowlist
    } catch (e) {
      holder.allowlist = null
      onError(e)
      return null
    }
  }
  holder.reload = reload
  reload()
  try {
    watch(path, { persistent: false }, () => reload())
  } catch {
    /* watcher unavailable; manual reload only */
  }
  return holder
}
