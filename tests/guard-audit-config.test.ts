// Config tests for guard audit / principal options.
// Run: bun test tests/guard-audit-config.test.ts

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { loadConfig } from "../src/config.ts"
import { resolveGuardAuditContext } from "../src/guard/guard.ts"
import { configKey } from "../src/state.ts"

const AUDIT_ENV = [
  "OPENCODE_GUARD_AUDIT_ENABLED", "OPENCODE_GUARD_AUDIT_PATH",
  "OPENCODE_GUARD_PRINCIPAL_SUB", "OPENCODE_GUARD_PRINCIPAL_ISS", "OPENCODE_GUARD_AUDIT_HMAC_KEY",
]

describe("guard audit config", () => {
  beforeEach(() => { for (const key of AUDIT_ENV) delete process.env[key] })
  afterEach(() => { for (const key of AUDIT_ENV) delete process.env[key] })

  test("audit is off by default with a default path", () => {
    const guard = loadConfig({}).guard
    expect(guard.guardAuditEnabled).toBe(false)
    expect(guard.guardAuditPath).toContain("otel-guard-audit.json")
  })

  test("reads audit options from env and options", () => {
    process.env["OPENCODE_GUARD_PRINCIPAL_SUB"] = "user-123"
    process.env["OPENCODE_GUARD_AUDIT_HMAC_KEY"] = "x".repeat(40)
    const guard = loadConfig({ guardAuditEnabled: true, guardAuditPath: "/tmp/a.json" }).guard
    expect(guard.guardAuditEnabled).toBe(true)
    expect(guard.guardAuditPath).toBe("/tmp/a.json")
    expect(guard.guardPrincipalSub).toBe("user-123")
  })

  test("principal and HMAC key cannot be injected via plugin options", () => {
    const guard = loadConfig({
      guardPrincipalSub: "attacker",
      guardAuditHmacKey: "y".repeat(40),
    } as never).guard
    expect(guard.guardPrincipalSub).toBeUndefined()
    expect(guard.guardAuditHmacKey).toBeUndefined()
  })

  test("guard fields do not affect configKey", () => {
    const a = loadConfig({})
    const b = loadConfig({ guardAuditEnabled: true, guardAuditPath: "/tmp/x.json" })
    expect(configKey(a)).toBe(configKey(b))
  })
})

describe("resolveGuardAuditContext", () => {
  test("refuses an HMAC key shorter than 32 bytes", () => {
    process.env["OPENCODE_GUARD_AUDIT_HMAC_KEY"] = "short"
    const ctx = resolveGuardAuditContext(loadConfig({}).guard)
    expect(ctx.hmacKey).toBeNull()
    expect(ctx.configError).toContain("32 bytes")
    delete process.env["OPENCODE_GUARD_AUDIT_HMAC_KEY"]
  })

  test("builds a principal with sub and optional iss", () => {
    process.env["OPENCODE_GUARD_PRINCIPAL_SUB"] = "user-1"
    process.env["OPENCODE_GUARD_PRINCIPAL_ISS"] = "issuer"
    const ctx = resolveGuardAuditContext(loadConfig({}).guard)
    expect(ctx.principal).toEqual({ sub: "user-1", iss: "issuer" })
    delete process.env["OPENCODE_GUARD_PRINCIPAL_SUB"]
    delete process.env["OPENCODE_GUARD_PRINCIPAL_ISS"]
  })
})

describe("guard prompt defense config", () => {
  const PD_ENV = ["OPENCODE_GUARD_PROMPT_DEFENSE", "OPENCODE_GUARD_PROMPT_DEFENSE_MIN_GRADE", "OPENCODE_GUARD_PROMPT_DEFENSE_INJECT"]
  beforeEach(() => { for (const key of PD_ENV) delete process.env[key] })
  afterEach(() => { for (const key of PD_ENV) delete process.env[key] })

  test("prompt defense is off by default with minGrade B", () => {
    const guard = loadConfig({}).guard
    expect(guard.guardPromptDefense).toBe(false)
    expect(guard.guardPromptDefenseMinGrade).toBe("B")
    expect(guard.guardPromptDefenseInjectContext).toBe(false)
  })

  test("reads env toggles and validates minGrade", () => {
    process.env["OPENCODE_GUARD_PROMPT_DEFENSE"] = "1"
    process.env["OPENCODE_GUARD_PROMPT_DEFENSE_MIN_GRADE"] = "b" // lowercased -> B
    process.env["OPENCODE_GUARD_PROMPT_DEFENSE_INJECT"] = "true"
    const guard = loadConfig({}).guard
    expect(guard.guardPromptDefense).toBe(true)
    expect(guard.guardPromptDefenseMinGrade).toBe("B")
    expect(guard.guardPromptDefenseInjectContext).toBe(true)
  })

  test("an invalid minGrade falls back to B", () => {
    process.env["OPENCODE_GUARD_PROMPT_DEFENSE_MIN_GRADE"] = "Z"
    expect(loadConfig({}).guard.guardPromptDefenseMinGrade).toBe("B")
  })

  test("prompt defense fields do not affect configKey", () => {
    const a = loadConfig({})
    const b = loadConfig({ guardPromptDefense: true, guardPromptDefenseInjectContext: true })
    expect(configKey(a)).toBe(configKey(b))
  })
})
