import { describe, test, expect } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLocalEventLog, toEpochMillis } from "../src/local-event-log.ts"

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "otel-local-event-log-"))
}

describe("toEpochMillis", () => {
  test("accepts epoch milliseconds, Date, and hrTime pairs", () => {
    expect(toEpochMillis(1794989404184)).toBe(1794989404184)
    expect(toEpochMillis(new Date(1794989404184))).toBe(1794989404184)
    expect(toEpochMillis([1794989404, 184_000_000])).toBe(1794989404184)
  })

  test("returns undefined for unusable input", () => {
    expect(toEpochMillis(undefined)).toBeUndefined()
    expect(toEpochMillis("1794989404184")).toBeUndefined()
    expect(toEpochMillis([1])).toBeUndefined()
  })
})

describe("createLocalEventLog", () => {
  test("appends one JSON object per line and creates the parent directory", () => {
    const dir = tempDir()
    const path = join(dir, "nested", "events.jsonl")
    const log = createLocalEventLog(path)
    log.append({
      time: "2026-11-18T08:10:04.184Z",
      severityText: "WARN",
      severityNumber: 13,
      body: "policy.decision",
      traceId: "c73d23d2664fe1dd8687c10d2ebc8bb9",
      spanId: "419e87e972313413",
      attributes: { "event.name": "policy.decision", "policy.decision": "would_denied" },
      resource: { "service.name": "opencode" },
    })
    log.append({
      time: "2026-11-18T08:10:05.000Z",
      body: "tool_decision",
      attributes: {},
      resource: { "service.name": "opencode" },
    })

    const lines = readFileSync(path, "utf8").trim().split("\n")
    expect(lines.length).toBe(2)
    const first = JSON.parse(lines[0]!)
    expect(first.body).toBe("policy.decision")
    expect(first.attributes["policy.decision"]).toBe("would_denied")
    expect(first.traceId).toBe("c73d23d2664fe1dd8687c10d2ebc8bb9")
    expect(JSON.parse(lines[1]!).body).toBe("tool_decision")
    rmSync(dir, { recursive: true, force: true })
  })

  test("goes quiet instead of throwing when the path is unwritable", () => {
    const dir = tempDir()
    const blocker = join(dir, "file")
    writeFileSync(blocker, "not a directory")
    const log = createLocalEventLog(join(blocker, "events.jsonl"))
    expect(() => log.append({ time: new Date(0).toISOString(), body: "x", attributes: {}, resource: {} })).not.toThrow()
    expect(() => log.append({ time: new Date(0).toISOString(), body: "y", attributes: {}, resource: {} })).not.toThrow()
    rmSync(dir, { recursive: true, force: true })
  })
})
