// Unit tests for the hash-chained audit module.
// Run: bun test tests/guard-audit.test.ts

import { describe, expect, test } from "bun:test"
import { createHash, createSecretKey } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendAuditEntry, computeArgsDigest, getAuditStatus, loadAuditFile, verifyAuditEntries } from "../src/guard/audit.ts"

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "guard-audit-"))
  return join(dir, "audit.json")
}

const entry = (overrides: Record<string, unknown> = {}) => ({
  action: "tool.bash", agentId: "opencode:session-1", decision: "deny", ...overrides,
})

describe("appendAuditEntry / verifyAuditEntries", () => {
  test("writes a verifiable chain and rejects tampering", async () => {
    const path = tempPath()
    const first = await appendAuditEntry(path, entry({ reason: "r1" }))
    const second = await appendAuditEntry(path, entry({ agentId: "opencode:session-2", reason: "r2" }))
    expect(second.previousHash).toBe(first.hash)
    const { seamHash, entries } = await loadAuditFile(path)
    expect(seamHash).toBeNull()
    expect(verifyAuditEntries(entries, seamHash)).toBe(true)

    const tampered = [...entries]
    tampered[0] = { ...(tampered[0] as object), decision: "allow" }
    expect(verifyAuditEntries(tampered, seamHash)).toBe(false)
  })

  test("rolls over with a seam hash and stays verifiable", async () => {
    const path = tempPath()
    for (let i = 0; i < 5; i += 1) await appendAuditEntry(path, entry({ reason: `r${i}` }), { limit: 3 })
    const { seamHash, entries } = await loadAuditFile(path)
    expect(entries.length).toBe(3)
    expect(seamHash).not.toBeNull()
    expect(verifyAuditEntries(entries, seamHash)).toBe(true)
    // bare array whose head does not anchor genesis must fail
    expect(verifyAuditEntries(entries, null)).toBe(false)
  })

  test("refuses to append to a broken chain", async () => {
    const path = tempPath()
    await appendAuditEntry(path, entry())
    const { entries } = await loadAuditFile(path)
    writeFileSync(path, JSON.stringify([{ ...(entries[0] as object), hash: "deadbeef" }]))
    await expect(appendAuditEntry(path, entry())).rejects.toThrow(/failed hash-chain/)
  })

  test("verifies legacy v1 entries byte-for-byte", () => {
    const e = {
      timestamp: "2020-01-01T00:00:00.000Z", agentId: "opencode:s", action: "tool.bash",
      decision: "allow", previousHash: "0".repeat(64),
    }
    const hash = createHash("sha256").update(JSON.stringify(e)).digest("hex")
    expect(verifyAuditEntries([{ ...e, hash }])).toBe(true)
  })

  test("getAuditStatus reports invalid chains", async () => {
    const path = tempPath()
    await appendAuditEntry(path, entry())
    expect((await getAuditStatus(path)).valid).toBe(true)
    writeFileSync(path, "[{\"hash\":\"nope\"}]")
    const status = await getAuditStatus(path)
    expect(status.valid).toBe(false)
    expect(status.error).toContain("failed hash-chain")
  })
})

describe("computeArgsDigest", () => {
  test("hashes canonical args independent of key order", () => {
    expect(computeArgsDigest({ b: 2, a: 1 }).argsDigest).toBe(computeArgsDigest({ a: 1, b: 2 }).argsDigest)
  })

  test("uses HMAC algorithm when a key is supplied", () => {
    const key = createSecretKey(Buffer.alloc(32, 7))
    const plain = computeArgsDigest({ a: 1 })
    const hmac = computeArgsDigest({ a: 1 }, { hmacKey: key })
    expect(plain.argsDigestAlg).toBe("sha256")
    expect(hmac.argsDigestAlg).toBe("hmac-sha256")
    expect(hmac.argsDigest).not.toBe(plain.argsDigest)
  })

  test("marks unserializable args without throwing", () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const result = computeArgsDigest(cycle)
    expect(result.argsUnserializable).toBe(true)
  })
})
