// Unit tests for the prompt defense evaluator and hook handler.
// Run: bun test tests/guard-prompt-defense.test.ts

import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { evaluatePromptDefense, isDefenseBlocking, PRODUCTION_GUARD_CONTEXT, type DefenseFinding } from "../src/guard/prompt-defense.ts"
import { handlePromptDefense, type PromptDefenseContextEvent } from "../src/guard/prompt-defense-hook.ts"
import type { HandlerContext } from "../src/types.ts"

describe("evaluatePromptDefense", () => {
  test("the 10 bundled lines score A (12/12)", () => {
    const report = evaluatePromptDefense(PRODUCTION_GUARD_CONTEXT.join("\n"))
    expect(report.grade).toBe("A")
    expect(report.score).toBe(100)
    expect(report.coverage).toBe("12/12")
    expect(report.missing).toEqual([])
  })

  test("empty prompt scores F with all vectors missing", () => {
    const report = evaluatePromptDefense("")
    expect(report.grade).toBe("F")
    expect(report.score).toBe(0)
    expect(report.missing.length).toBe(12)
  })

  test("partial prompt reports only the missing vectors", () => {
    const report = evaluatePromptDefense("You are a helpful assistant. Never reveal secrets.")
    expect(report.defended).toBeGreaterThan(0)
    expect(report.defended).toBeLessThan(12)
    expect(report.missing.length).toBe(12 - report.defended)
    expect(report.findings.every((f: DefenseFinding) => typeof f.defended === "boolean")).toBe(true)
  })

  test("promptHash is sha256 of the exact text", () => {
    const text = "hello world"
    expect(evaluatePromptDefense(text).promptHash).toBe(createHash("sha256").update(text).digest("hex"))
  })

  test("rejects prompts over 100000 chars", () => {
    expect(() => evaluatePromptDefense("x".repeat(100_001))).toThrow(/exceeds maximum/)
  })

  test("isDefenseBlocking compares grade order", () => {
    const a = evaluatePromptDefense(PRODUCTION_GUARD_CONTEXT.join("\n"))
    const f = evaluatePromptDefense("")
    expect(isDefenseBlocking(a, "B")).toBe(false)
    expect(isDefenseBlocking(f, "B")).toBe(true)
    expect(isDefenseBlocking(f, "F")).toBe(false)
  })
})

describe("handlePromptDefense", () => {
  const makeCtx = (events: Array<Record<string, unknown>>) => ({
    emitEvent: (record: Record<string, unknown>) => events.push(record),
    semconv: "gen_ai",
    commonAttrs: { "service.name": "test" },
  }) as unknown as HandlerContext

  const logs: Array<{ level: string; message: string; extra?: Record<string, unknown> }> = []
  const log = async (level: string, message: string, extra?: Record<string, unknown>) => {
    logs.push({ level, message, extra })
  }

  test("emits prompt_defense with no prompt text", async () => {
    const events: Array<Record<string, unknown>> = []
    const ctx = makeCtx(events)
    const event: PromptDefenseContextEvent = {
      sessionID: "s1", agent: "main",
      system: [{ type: "text", text: "You are a helpful assistant" }],
    }
    await handlePromptDefense(event, ctx, { minGrade: "B", injectContext: false, failMode: "fail_open" }, log)
    expect(events.length).toBe(1)
    const attrs = events[0]!.attributes as Record<string, unknown>
    expect(attrs["event.name"]).toBe("prompt_defense")
    expect(typeof attrs["prompt_defense.prompt_hash"]).toBe("string")
    expect(JSON.stringify(attrs)).not.toContain("You are a helpful assistant")
  })

  test("injects the 10 lines exactly once when enabled", async () => {
    const events: Array<Record<string, unknown>> = []
    const event: PromptDefenseContextEvent = {
      sessionID: "s1", system: [{ type: "text", text: "base" }],
    }
    const options = { minGrade: "B", injectContext: true, failMode: "fail_open" as const }
    await handlePromptDefense(event, makeCtx(events), options, log)
    expect(event.system.length).toBe(1 + PRODUCTION_GUARD_CONTEXT.length)
    await handlePromptDefense(event, makeCtx(events), options, log)
    expect(event.system.length).toBe(1 + PRODUCTION_GUARD_CONTEXT.length) // idempotent
  })

  test("never throws on scoring error", async () => {
    const event = { sessionID: "s1", system: null } as unknown as PromptDefenseContextEvent
    await handlePromptDefense(event, makeCtx([]), { minGrade: "B", injectContext: false, failMode: "fail_open" }, log)
  })
})
