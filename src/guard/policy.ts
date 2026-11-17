// otel.guard — policy loading, normalization, and matching.
// Zero third-party dependencies. The policy file is JSON (S3 rule page export format);
// hot-reloaded on change via fs.watch with last-good retention.

import { readFileSync, watch } from "node:fs"
import { createHash } from "node:crypto"
import { canonicalJson } from "./canonical-json.ts"

/** Rule verdict types, in decision-precedence order (deny wins over review, warn, allow). */
export const RULE_TYPES = ["allow", "deny", "review", "warn"] as const
export type RuleType = (typeof RULE_TYPES)[number]

/** Guard operating modes: monitor_only shadows with `would_denied`, enforce mutates effects. */
export const MODES = ["monitor_only", "enforce"] as const
export type GuardMode = (typeof MODES)[number]

/** Failure semantics when the guard itself throws. */
export type GuardFailMode = "fail_open" | "fail_closed"

export type PolicySettings = {
  mode: GuardMode
  fail_mode: GuardFailMode
  unmatched: string
  /** Optional telemetry fields tolerated in the policy file; not used by the guard. */
  endpoint?: string
  service_name?: string
  environment?: string
}

export type GuardRule = {
  id: string
  name: string
  type: RuleType
  severity: string
  description: string
  /** Lowercased tool names this rule applies to; `null` matches every tool. */
  tools: string[] | null
  regex: RegExp | null
  contains: string | null
  raw: unknown
}

export type GuardPolicy = {
  settings: PolicySettings
  rules: GuardRule[]
  version: string
  /** Content hash of the raw policy document, for audit provenance. */
  version_sha256: string
  sourcePath: string
  loadedAt: number
}

/** Minimal shape of a `permission.evaluate` hook event the matcher needs. */
export type GuardEvaluateEvent = {
  action?: string
  resources?: ReadonlyArray<unknown>
}

export class PolicyError extends Error {}

/** Command regex flags allowed by the guard. g/y/m/s are rejected: stateful or
 * multiline matching can make an anchored policy history-dependent or match only
 * one line of a multi-command string. */
const ALLOWED_REGEX_FLAGS = new Set(["i", "u"])
/** Upper bound on a command regex source (mirrors AGT's MAX_REGEX_LENGTH). */
const MAX_REGEX_SOURCE = 2048

// decision precedence when multiple rules match: deny wins, then review, warn, allow
const PRECEDENCE: Record<RuleType, number> = { deny: 0, review: 1, warn: 2, allow: 3 }

export function defaultSettings(): PolicySettings {
  return {
    mode: "monitor_only",
    fail_mode: "fail_open",
    unmatched: "passthrough",
  }
}

export function loadPolicyFile(path: string): GuardPolicy {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (e) {
    throw new PolicyError(`policy file unreadable: ${path}: ${e instanceof Error ? e.message : e}`)
  }
  const doc = JSON.parse(raw) as unknown
  return normalizePolicy(doc, path)
}

export function normalizePolicy(doc: unknown, sourcePath = ""): GuardPolicy {
  if (!doc || typeof doc !== "object") throw new PolicyError("policy root must be an object")
  const root = doc as { settings?: Record<string, unknown>; rules?: unknown[]; version?: string }
  const s = { ...defaultSettings(), ...(root.settings ?? {}) } as PolicySettings
  if (!MODES.includes(s.mode as GuardMode)) throw new PolicyError(`invalid settings.mode: ${s.mode}`)
  if (s.fail_mode !== "fail_open" && s.fail_mode !== "fail_closed") {
    throw new PolicyError(`invalid settings.fail_mode: ${s.fail_mode}`)
  }
  const rules = (Array.isArray(root.rules) ? root.rules : []).map((r, i) => normalizeRule(r, i))
  // RFC 8785 canonical form so key insertion order cannot change the version hash.
  const sha256 = createHash("sha256").update(canonicalJson(doc) ?? "null").digest("hex")
  return {
    settings: s,
    rules,
    version: typeof root.version === "string" ? root.version : "",
    version_sha256: `sha256:${sha256}`,
    sourcePath,
    loadedAt: Date.now(),
  }
}

function normalizeRule(r: unknown, i: number): GuardRule {
  if (!r || typeof r !== "object") throw new PolicyError(`rule[${i}] must be an object`)
  const rule = r as Record<string, unknown>
  for (const k of ["id", "name", "type"]) {
    if (typeof rule[k] !== "string" || !rule[k]) throw new PolicyError(`rule[${i}].${k} must be a non-empty string`)
  }
  if (!RULE_TYPES.includes(rule.type as RuleType)) throw new PolicyError(`rule[${i}] invalid type: ${rule.type}`)
  if (!/^[\w.\-]+$/.test(rule.id as string)) throw new PolicyError(`rule[${i}].id must match [\\w.\\-]+`)
  let re: RegExp | null = null
  const match = (rule.match ?? {}) as { command_regex?: unknown; command_regex_flags?: unknown; resource_contains?: unknown }
  if (match.command_regex !== undefined) {
    if (typeof match.command_regex !== "string") throw new PolicyError(`rule[${i}] command_regex must be a string`)
    if (!match.command_regex.length) throw new PolicyError(`rule[${i}] command_regex must not be empty`)
    if (match.command_regex.length > MAX_REGEX_SOURCE) {
      throw new PolicyError(`rule[${i}] command_regex exceeds ${MAX_REGEX_SOURCE} characters`)
    }
    const flags = match.command_regex_flags === undefined ? "i" : match.command_regex_flags
    if (typeof flags !== "string" || [...flags].some((f) => !ALLOWED_REGEX_FLAGS.has(f))) {
      throw new PolicyError(`rule[${i}] command_regex_flags may only contain i/u (g/y/m/s are rejected)`)
    }
    let compiled: RegExp
    try {
      compiled = new RegExp(match.command_regex, flags)
    } catch (e) {
      throw new PolicyError(`rule[${i}] bad command_regex: ${e instanceof Error ? e.message : e}`)
    }
    // A pattern that matches the empty string would match every evaluation,
    // turning a deny rule into a blanket block (or an allow into a blanket bypass).
    if (compiled.test("")) throw new PolicyError(`rule[${i}] command_regex must not match the empty string`)
    re = compiled
  }
  return {
    id: rule.id as string,
    name: rule.name as string,
    type: rule.type as RuleType,
    severity: typeof rule.severity === "string" ? rule.severity : "medium",
    description: typeof rule.description === "string" ? rule.description : "",
    tools: Array.isArray(rule.tools) && rule.tools.length
      ? rule.tools.map((t) => String(t).toLowerCase())
      : null, // null = all tools
    regex: re,
    contains: typeof match.resource_contains === "string" ? match.resource_contains.toLowerCase() : null,
    raw: r,
  }
}

/** Match rules against an evaluate event. Returns the matched normalized rules. */
export function matchRules(policy: GuardPolicy, event: GuardEvaluateEvent): GuardRule[] {
  const action = String(event?.action ?? "").toLowerCase()
  // for shell-type actions the command text lives in resources[0]; join everything as haystack
  const haystack = (event?.resources ?? [])
    .map((r) => (typeof r === "string" ? r : JSON.stringify(r)))
    .join("\n")
  const hayLower = haystack.toLowerCase()
  const out: GuardRule[] = []
  for (const rule of policy.rules) {
    if (rule.tools && !rule.tools.includes(action)) continue
    if (rule.regex && !rule.regex.test(haystack)) continue
    if (rule.contains && !hayLower.includes(rule.contains)) continue
    if (!rule.regex && !rule.contains) continue // a rule must have at least one matcher
    out.push(rule)
  }
  return out
}

/** Highest-precedence matched rule (deny > review > warn > allow). */
export function topRule(matched: GuardRule[]): GuardRule | null {
  if (!matched.length) return null
  return matched.reduce((best, r) => (PRECEDENCE[r.type] < PRECEDENCE[best.type] ? r : best))
}

export type PolicyHolder = {
  policy: GuardPolicy | null
  reload: () => GuardPolicy | null
}

/** Loads the policy and watches the file, reloading into the same holder (last-good on error). */
export function makePolicyHolder(path: string, onError: (e: unknown) => void = () => {}): PolicyHolder {
  const holder: PolicyHolder = {
    policy: null,
    reload: () => null,
  }
  const reload = () => {
    try {
      holder.policy = loadPolicyFile(path)
      return holder.policy
    } catch (e) {
      onError(e) // keep last good policy
      return holder.policy
    }
  }
  holder.reload = reload
  holder.policy = reload()
  try {
    watch(path, { persistent: false }, () => reload()) // works in node & bun; non-persistent so it never keeps the process alive
  } catch {
    /* watcher unavailable; manual reload only */
  }
  return holder
}
