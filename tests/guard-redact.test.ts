// Unit tests for P5b tool-output secret redaction.
// Run: bun test tests/guard-redact.test.ts

import { describe, expect, test } from "bun:test"
import { scanSecrets, redactSecrets, redactContent, SECRET_PATTERNS } from "../src/guard/redact.ts"

const AWS = "AKIAIOSFODNN7EXAMPLE"
const GH = `ghp_${"a".repeat(36)}`
const OPENAI = `sk-${"b".repeat(32)}`
const JWT = `eyJhbGciOiJIUzI1NiJ9.${"c".repeat(20)}.${"d".repeat(27)}`

describe("secret scanning", () => {
  test("detects well-known credential shapes", () => {
    expect(scanSecrets(AWS)).toContain("aws_access_key")
    expect(scanSecrets(GH)).toContain("github_pat")
    expect(scanSecrets(OPENAI)).toContain("openai_key")
    expect(scanSecrets(JWT)).toContain("jwt")
    expect(scanSecrets("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).toContain("pem_private_key")
    expect(scanSecrets(`AccountKey=${"e".repeat(50)}`)).toContain("azure_storage_key")
  })

  test("clean text produces no findings", () => {
    expect(scanSecrets("hello world, no secrets here")).toEqual([])
    expect(scanSecrets("")).toEqual([])
  })

  test("reports multiple distinct pattern ids once each", () => {
    const found = scanSecrets(`${AWS} ${AWS} ${GH}`)
    expect(found.sort()).toEqual(["aws_access_key", "github_pat"])
  })

  test("all patterns carry a stable id and flags", () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThanOrEqual(6)
    for (const p of SECRET_PATTERNS) {
      expect(p.id).toBeTruthy()
      expect(p.source).toBeTruthy()
      expect(p.flags).toContain("g")
    }
  })
})

describe("redaction", () => {
  test("replaces secrets with indexed placeholders", () => {
    const out = redactSecrets(`token=${GH} end`)
    expect(out.text).toBe("token=[REDACTED:github_pat] end")
    expect(out.matches).toEqual(["github_pat"])
  })

  test("redacts multiple patterns in one pass", () => {
    const out = redactSecrets(`${AWS} and ${OPENAI}`)
    expect(out.text).toContain("[REDACTED:aws_access_key]")
    expect(out.text).toContain("[REDACTED:openai_key]")
    expect(out.matches).toContain("aws_access_key")
    expect(out.matches).toContain("openai_key")
  })

  test("leaves clean text unchanged", () => {
    const out = redactSecrets("all good")
    expect(out.text).toBe("all good")
    expect(out.matches).toEqual([])
  })

  test("redacts string content", () => {
    const out = redactContent(`key ${OPENAI}`)
    expect(out.content).toBe("key [REDACTED:openai_key]")
    expect(out.matches).toEqual(["openai_key"])
  })

  test("redacts text parts and preserves other content parts", () => {
    const out = redactContent([
      { type: "text", text: `secret ${AWS}` },
      { type: "file", uri: "file:///tmp/a", mime: "text/plain" },
    ])
    expect(Array.isArray(out.content)).toBe(true)
    const parts = out.content as Array<Record<string, unknown>>
    expect(parts[0]?.text).toBe("secret [REDACTED:aws_access_key]")
    expect(parts[1]).toEqual({ type: "file", uri: "file:///tmp/a", mime: "text/plain" })
    expect(out.matches).toEqual(["aws_access_key"])
  })

  test("undefined content stays undefined", () => {
    expect(redactContent(undefined)).toEqual({ content: undefined, matches: [], truncated: false })
  })

  test("does not mutate the input content array", () => {
    const original = [{ type: "text", text: GH }]
    redactContent(original)
    expect(original[0]?.text).toBe(GH)
  })
})
