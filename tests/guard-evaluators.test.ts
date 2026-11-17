// Unit tests for evaluator aggregation: per-evaluator fail-closed and deny attribution.
// Run: bun test tests/guard-evaluators.test.ts

import { describe, expect, test } from "bun:test"
import { normalizePolicy, type GuardRule } from "../src/guard/policy.ts"
import { decide, decideFromEvaluators, failDecide, runEvaluators, verdictForRule, type GuardEvaluator } from "../src/guard/decide.ts"

const policy = (mode: "monitor_only" | "enforce") => normalizePolicy({ settings: { mode }, rules: [] }, "test")
const rule = (id: string, type: GuardRule["type"]): GuardRule => ({
  id, name: id, type, severity: "high", description: "", tools: null,
  regex: /x/i, contains: null, raw: {},
})

describe("runEvaluators", () => {
  test("picks deny over review/warn/allow regardless of order", () => {
    const evs: GuardEvaluator[] = [
      { id: "allow", evaluate: () => ({ verdict: "allow" }) },
      { id: "deny", evaluate: () => ({ verdict: "deny", rule: rule("d", "deny") }) },
      { id: "review", evaluate: () => ({ verdict: "review" }) },
      { id: "warn", evaluate: () => ({ verdict: "warn" }) },
    ]
    const agg = runEvaluators(evs)
    expect(agg.winner.verdict).toBe("deny")
    expect(agg.deniedBy).toEqual(["deny"])
    expect(agg.errors).toEqual([])
  })

  test("a throwing evaluator becomes a deny candidate and is attributed", () => {
    const agg = runEvaluators([
      { id: "broken", evaluate: () => { throw new Error("boom") } },
    ])
    expect(agg.winner.verdict).toBe("deny")
    expect(agg.winner.message).toContain("broken")
    expect(agg.winner.message).toContain("boom")
    expect(agg.deniedBy).toEqual(["broken"])
    expect(agg.errors).toEqual([{ evaluator: "broken", message: "boom" }])
  })

  test("one broken evaluator does not hide other evaluators' denies", () => {
    const agg = runEvaluators([
      { id: "broken", evaluate: () => { throw new Error("boom") } },
      { id: "rules", evaluate: () => ({ verdict: "deny", rule: rule("d", "deny") }) },
      { id: "clean", evaluate: () => ({ verdict: "passthrough" }) },
    ])
    expect(agg.winner.verdict).toBe("deny")
    expect(agg.winner.rule?.id).toBe("d") // rules deny beats the thrown deny (later, same precedence)
    expect(new Set(agg.deniedBy)).toEqual(new Set(["broken", "rules"]))
    expect(agg.errors.map((e) => e.evaluator)).toEqual(["broken"])
  })

  test("undefined verdict from an evaluator is skipped", () => {
    const agg = runEvaluators([
      { id: "skip", evaluate: () => undefined },
      { id: "warn", evaluate: () => ({ verdict: "warn" }) },
    ])
    expect(agg.winner.verdict).toBe("warn")
    expect(agg.deniedBy).toEqual([])
  })

  test("empty evaluator list resolves to passthrough", () => {
    const agg = runEvaluators([])
    expect(agg.winner.verdict).toBe("passthrough")
    expect(agg.deniedBy).toEqual([])
  })
})

describe("decideFromEvaluators", () => {
  test("enforce denies and carries deniedBy / errored attribution", () => {
    const out = decideFromEvaluators(policy("enforce"), [
      { id: "rules", evaluate: () => ({ verdict: "deny", rule: rule("d", "deny"), message: "blocked" }) },
    ], "allow")
    expect(out.decision).toBe("denied")
    expect(out.effect).toBe("deny")
    expect(out.deniedBy).toEqual(["rules"])
    expect(out.message).toBe("blocked")
  })

  test("monitor_only shadows a deny verdict without mutating effect", () => {
    const out = decideFromEvaluators(policy("monitor_only"), [
      { id: "rules", evaluate: () => ({ verdict: "deny", rule: rule("d", "deny") }) },
    ], "allow")
    expect(out.decision).toBe("would_denied")
    expect(out.effect).toBeUndefined()
  })

  test("a throwing evaluator fails closed under enforce and is labelled degraded-safe", () => {
    const out = decideFromEvaluators(policy("enforce"), [
      { id: "bad", evaluate: () => { throw new Error("oops") } },
    ], "allow")
    expect(out.decision).toBe("denied")
    expect(out.effect).toBe("deny")
    expect(out.errored).toEqual(["bad"])
  })

  test("baseEffect handling matches legacy decide for review and allow", () => {
    const review = decideFromEvaluators(policy("enforce"), [
      { id: "rules", evaluate: () => ({ verdict: "review", rule: rule("r", "review") }) },
    ], "allow")
    expect(review.effect).toBe("ask")
    const allow = decideFromEvaluators(policy("enforce"), [
      { id: "rules", evaluate: () => ({ verdict: "allow", rule: rule("a", "allow") }) },
    ], "ask")
    expect(allow.effect).toBe("allow")
  })

  test("legacy decide keeps identical behaviour and adds empty attribution", () => {
    const p = policy("enforce")
    const out = decide(p, [rule("d", "deny")], "allow")
    expect(out.decision).toBe("denied")
    expect(out.deniedBy).toEqual(["d"])
    expect(out.errored).toEqual([])
    expect(decide(p, [], "allow").decision).toBe("passthrough")
  })
})

describe("failDecide attribution", () => {
  test("failDecide carries empty attribution fields", () => {
    expect(failDecide("fail_open", new Error("x")).errored).toEqual([])
    expect(failDecide("fail_open", new Error("x")).deniedBy).toEqual([])
  })

  test("verdictForRule generates messages for all rule types", () => {
    expect(verdictForRule(rule("d", "deny")).message).toContain("d")
    expect(verdictForRule(rule("r", "review")).verdict).toBe("review")
    expect(verdictForRule(rule("w", "warn")).verdict).toBe("warn")
    expect(verdictForRule(rule("a", "allow")).verdict).toBe("allow")
  })
})
