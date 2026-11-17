// otel.guard — hash-chained, tamper-evident audit log.
// Ported from microsoft/agent-governance-toolkit lib/audit.mjs (MIT).
// Zero third-party dependencies (node:crypto / node:fs only).
//
// Each entry's hash covers every other field via RFC 8785 canonical JSON, and
// previousHash links it to the chain head. On rollover the last evicted hash is
// retained as a seam so the surviving head still anchors to something verifiable.

import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { canonicalJson } from "./canonical-json.ts"

/** Genesis anchor for a chain that has never been rolled over. */
const GENESIS_HASH = "0".repeat(64)
/** Default maximum retained entries. */
export const AUDIT_MAX_ENTRIES = 10000
/** Largest argument payload digested before truncation. */
export const AUDIT_ARGS_DIGEST_MAX_BYTES = 1024 * 1024
/** Schema version stamped on every entry written by this module. */
const AUDIT_ENTRY_VERSION = 2
/** Placeholder digest when arguments cannot be serialized at all. */
const UNSERIALIZABLE_SENTINEL = "[unserializable]"
/** Exact keys a v1 entry may carry, sorted. */
const V1_KEYS = ["action", "agentId", "decision", "hash", "previousHash", "timestamp"]
/** Allowed keys on a v2 entry. */
const V2_ALLOWED_KEYS = new Set([
  "v", "timestamp", "agentId", "action", "decision", "previousHash", "hash",
  "policyVersion", "reason", "argsDigest", "argsDigestAlg", "argsTruncated",
  "argsUnserializable", "principal",
])
/** Required string keys on a v2 entry. */
const V2_REQUIRED_STRINGS = ["timestamp", "agentId", "action", "decision", "previousHash", "hash"]
/** Accepted digest algorithms. */
const V2_DIGEST_ALGORITHMS = new Set(["sha256", "hmac-sha256"])
/** Allowed principal keys. */
const PRINCIPAL_ALLOWED_KEYS = new Set(["sub", "iss"])

/** Operator-declared identity the agent acted for. */
export type AuditPrincipal = { sub: string; iss?: string }

/** Fields a caller supplies for a new audit entry; timestamp/hash/chain are added by the writer. */
export type AuditEntryInput = {
  action: string
  agentId: string
  decision: string
  policyVersion?: string
  reason?: string
  argsDigest?: string
  argsDigestAlg?: string
  argsTruncated?: boolean
  argsUnserializable?: boolean
  principal?: AuditPrincipal
}

/** A fully written v2 audit entry. */
export type AuditEntry = AuditEntryInput & {
  v: 2
  timestamp: string
  previousHash: string
  hash: string
}

/** Shape of the on-disk audit file. A bare array (seamHash null) means never rolled over. */
export type AuditFile = { seamHash: string | null; entries: unknown[] }

/** Options for {@link appendAuditEntry}. */
export type AppendAuditOptions = { limit?: number }

/** Result of {@link computeArgsDigest}. */
export type ArgsDigest = {
  argsDigest: string
  argsDigestAlg: string
  argsTruncated?: boolean
  argsUnserializable?: boolean
}

/** Options for {@link computeArgsDigest}. */
export type ArgsDigestOptions = { hmacKey?: import("node:crypto").KeyObject | null }

/**
 * Append an entry to the audit chain, verifying the existing chain first.
 * Throws on a broken chain (caller decides fail-closed semantics). Rollover
 * keeps a seam hash so the chain remains verifiable after eviction.
 */
export async function appendAuditEntry(
  auditPath: string,
  entry: AuditEntryInput,
  options: AppendAuditOptions = {},
): Promise<AuditEntry> {
  const limit = options.limit ?? AUDIT_MAX_ENTRIES
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError(`Audit entry limit must be a positive integer, received ${String(limit)}.`)

  const { seamHash, entries } = await loadAuditFile(auditPath)
  if (!verifyAuditEntries(entries, seamHash)) throw new Error(`Audit log at ${auditPath} failed hash-chain verification.`)
  const previousHash = entries.length > 0 ? (entries[entries.length - 1] as { hash: string }).hash : seamHash ?? GENESIS_HASH
  const timestamp = new Date().toISOString()

  const record = stripUndefined({
    v: AUDIT_ENTRY_VERSION,
    timestamp,
    agentId: entry.agentId,
    action: entry.action,
    decision: entry.decision,
    previousHash,
    policyVersion: entry.policyVersion,
    reason: entry.reason,
    argsDigest: entry.argsDigest,
    argsDigestAlg: entry.argsDigestAlg,
    argsTruncated: entry.argsTruncated === true ? true : undefined,
    argsUnserializable: entry.argsUnserializable === true ? true : undefined,
    principal: entry.principal,
  })
  if (!isValidV2Shape({ ...record, hash: GENESIS_HASH })) throw new TypeError("Refusing to write a malformed audit entry.")

  const nextEntry = { ...record, hash: hashCanonicalRecord(record) } as AuditEntry
  const combined = [...entries, nextEntry]
  let nextSeam = seamHash
  let nextEntries: unknown[] = combined
  if (combined.length > limit) {
    const overflow = combined.length - limit
    nextSeam = (combined[overflow - 1] as { hash: string }).hash
    nextEntries = combined.slice(overflow)
  }
  await writeAuditFile(auditPath, nextSeam, nextEntries)
  return nextEntry
}

/**
 * Digest tool arguments so an entry can be joined against another system's
 * record without storing the arguments. Never throws: a digest failure must
 * not be able to deny a request. Use an HMAC key when low-entropy args matter.
 */
export function computeArgsDigest(args: unknown, options: ArgsDigestOptions = {}): ArgsDigest {
  const hmacKey = options.hmacKey ?? null
  const algorithm = hmacKey ? "hmac-sha256" : "sha256"
  let truncated = false
  let unserializable = false
  let payload: Buffer

  try {
    const serialized = canonicalJson(args, { lenient: true })
    let buffer = Buffer.from(serialized ?? "null", "utf8")
    if (buffer.byteLength > AUDIT_ARGS_DIGEST_MAX_BYTES) {
      buffer = buffer.subarray(0, AUDIT_ARGS_DIGEST_MAX_BYTES)
      truncated = true
    }
    payload = buffer
  } catch {
    payload = Buffer.from(UNSERIALIZABLE_SENTINEL, "utf8")
    unserializable = true
  }

  let argsDigest: string
  try {
    argsDigest = hmacKey
      ? createHmac("sha256", hmacKey).update(payload).digest("hex")
      : createHash("sha256").update(payload).digest("hex")
  } catch {
    return { argsDigest: createHash("sha256").update(UNSERIALIZABLE_SENTINEL, "utf8").digest("hex"), argsDigestAlg: "sha256", argsUnserializable: true }
  }
  return {
    argsDigest,
    argsDigestAlg: algorithm,
    ...(truncated ? { argsTruncated: true } : {}),
    ...(unserializable ? { argsUnserializable: true } : {}),
  }
}

/** Read the audit file in either shape it can take (bare array or seam object). */
export async function loadAuditFile(auditPath: string): Promise<AuditFile> {
  if (!auditPath || !existsSync(auditPath)) return { seamHash: null, entries: [] }
  try {
    const text = await readFile(auditPath, "utf8")
    const value: unknown = JSON.parse(text)
    if (Array.isArray(value)) return { seamHash: null, entries: value }
    if (isObject(value) && Array.isArray(value.entries)) {
      return { seamHash: typeof value.seamHash === "string" ? value.seamHash : null, entries: value.entries }
    }
    throw new Error("not a recognised audit format")
  } catch (error) {
    throw new Error(`Audit log at ${auditPath} is unreadable or corrupt: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Verify every chain link and hash in an entry list. Total: returns false, never throws. */
export function verifyAuditEntries(entries: unknown[], seamHash: string | null = null): boolean {
  if (!Array.isArray(entries)) return false
  let sawVersionedEntry = false
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const expectedPrev = index === 0 ? seamHash ?? GENESIS_HASH : (entries[index - 1] as { hash: string }).hash
    if (!isObject(entry) || entry.previousHash !== expectedPrev) return false
    const versioned = Object.hasOwn(entry as object, "v")
    // Versions only ever go up; an attacker cannot strip `v` from the final entry.
    if (sawVersionedEntry && !versioned) return false
    sawVersionedEntry = sawVersionedEntry || versioned
    const expectedHash = computeEntryHash(entry as Record<string, unknown>)
    if (expectedHash === null) return false
    const actualHash = String(entry.hash ?? "")
    if (Buffer.byteLength(actualHash, "utf8") !== Buffer.byteLength(expectedHash, "utf8")) return false
    if (!timingSafeEqual(Buffer.from(actualHash, "utf8"), Buffer.from(expectedHash, "utf8"))) return false
  }
  return true
}

/** Summarize audit file validity and entry count without exposing entries. */
export async function getAuditStatus(auditPath: string): Promise<{ count: number; error?: string; valid: boolean }> {
  try {
    const { seamHash, entries } = await loadAuditFile(auditPath)
    const valid = verifyAuditEntries(entries, seamHash)
    return { count: entries.length, ...(valid ? {} : { error: `Audit log at ${auditPath} failed hash-chain verification.` }), valid }
  } catch (error) {
    return { count: 0, error: error instanceof Error ? error.message : String(error), valid: false }
  }
}

function computeEntryHash(entry: Record<string, unknown>): string | null {
  if (!isObject(entry)) return null
  if (!Object.hasOwn(entry, "v")) {
    const keys = Object.keys(entry).sort()
    if (keys.length !== V1_KEYS.length || keys.some((key, i) => key !== V1_KEYS[i])) return null
    return createHash("sha256").update(JSON.stringify({
      timestamp: entry.timestamp, agentId: entry.agentId, action: entry.action,
      decision: entry.decision, previousHash: entry.previousHash,
    })).digest("hex")
  }
  if (entry.v !== AUDIT_ENTRY_VERSION || !isValidV2Shape(entry)) return null
  const { hash: _ignored, ...record } = entry
  try {
    return hashCanonicalRecord(record)
  } catch {
    return null
  }
}

function hashCanonicalRecord(record: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(record) ?? "null", "utf8").digest("hex")
}

function isValidV2Shape(entry: Record<string, unknown>): boolean {
  for (const key of Object.keys(entry)) if (!V2_ALLOWED_KEYS.has(key)) return false
  for (const key of V2_REQUIRED_STRINGS) {
    if (typeof entry[key] !== "string" || (entry[key] as string).length === 0) return false
  }
  if (entry.v !== AUDIT_ENTRY_VERSION) return false
  for (const key of ["policyVersion", "reason", "argsDigest", "argsDigestAlg"]) {
    if (Object.hasOwn(entry, key) && typeof entry[key] !== "string") return false
  }
  const hasDigest = Object.hasOwn(entry, "argsDigest")
  const hasAlgorithm = Object.hasOwn(entry, "argsDigestAlg")
  if (hasDigest !== hasAlgorithm) return false
  if (hasAlgorithm && !V2_DIGEST_ALGORITHMS.has(entry.argsDigestAlg as string)) return false
  for (const key of ["argsTruncated", "argsUnserializable"]) {
    if (Object.hasOwn(entry, key) && entry[key] !== true) return false
  }
  if (Object.hasOwn(entry, "principal") && !isValidPrincipal(entry.principal)) return false
  return true
}

function isValidPrincipal(principal: unknown): boolean {
  if (!isPlainObject(principal)) return false
  for (const key of Object.keys(principal)) if (!PRINCIPAL_ALLOWED_KEYS.has(key)) return false
  if (typeof principal.sub !== "string" || principal.sub.length === 0) return false
  if (Object.hasOwn(principal, "iss") && typeof principal.iss !== "string") return false
  return true
}

function stripUndefined(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) if (value !== undefined) result[key] = value
  return result
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

async function writeAuditFile(auditPath: string, seamHash: string | null, entries: unknown[]): Promise<void> {
  await mkdir(dirname(auditPath), { recursive: true })
  const payload = seamHash === null ? entries : { seamHash, entries }
  const tempPath = `${auditPath}.tmp-${process.pid}`
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
  await rename(tempPath, auditPath)
}
