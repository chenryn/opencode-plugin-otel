// otel.guard — decision matrix + pluggable evaluator aggregation.
// Maps (evaluator verdicts, policy mode, base effect) -> final effect + label.
// The evaluator layer follows the fail-closed backend pattern from Microsoft AGT's
// PolicyEngine.runActionBackend: a throwing evaluator becomes a deny candidate.

import { topRule, type GuardFailMode, type GuardPolicy, type GuardRule } from "./policy.ts"

/** All possible `policy.decision` labels. */
export const DECISIONS = [
  "allowed",
  "denied",
  "would_denied",
  "warned",
  "review",
  "passthrough",
  "degraded",
] as const
export type Decision = (typeof DECISIONS)[number]

/** Base effects decided by opencode's own permission rules. */
export type BaseEffect = "allow" | "ask" | "deny"

/** Candidate verdicts an evaluator may return, in ascending decision precedence. */
export const VERDICTS = ["passthrough", "allow", "warn", "review", "deny"] as const
export type Verdict = (typeof VERDICTS)[number]

/** Precedence table for merging evaluator candidates (deny wins). */
const VERDICT_PRECEDENCE: Record<Verdict, number> = {
  passthrough: 0, allow: 1, warn: 2, review: 3, deny: 4,
}

/** Raw candidate from one evaluator, before mode/baseEffect resolution. */
export type EvaluatorVerdict = {
  verdict: Verdict
  rule?: GuardRule | null
  message?: string
}

/** A pluggable decision evaluator with a stable id for deny attribution. */
export type GuardEvaluator = {
  id: string
  evaluate: () => EvaluatorVerdict | undefined
}

/** Aggregated evaluator results: winning candidate plus deny/error attribution. */
export type EvaluatorAggregate = {
  winner: EvaluatorVerdict
  deniedBy: string[]
  errors: { evaluator: string; message: string }[]
}

export type DecisionOutcome = {
  /** Effect handed back to opencode; `undefined` keeps the base effect. */
  effect?: BaseEffect
  decision: Decision
  rule: GuardRule | null
  message: string
  /** Evaluator ids that returned a deny verdict (attribution, low cardinality). */
  deniedBy: string[]
  /** Evaluator ids that threw and were converted to denies. */
  errored: string[]
}

/**
 * Run every evaluator independently: a throwing evaluator becomes a deny
 * candidate (fail-closed) without preventing the others from running. Returns
 * the highest-precedence winner plus which evaluators denied or errored.
 */
export function runEvaluators(evaluators: readonly GuardEvaluator[]): EvaluatorAggregate {
  const deniedBy: string[] = []
  const errors: { evaluator: string; message: string }[] = []
  let winner: EvaluatorVerdict = { verdict: "passthrough" }
  for (const evaluator of evaluators) {
    let candidate: EvaluatorVerdict | undefined
    try {
      candidate = evaluator.evaluate()
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      errors.push({ evaluator: evaluator.id, message: detail })
      candidate = { verdict: "deny", message: `otel.guard: evaluator ${evaluator.id} failed: ${detail}` }
    }
    if (!candidate) continue
    if (candidate.verdict === "deny") deniedBy.push(evaluator.id)
    const candidateScore = VERDICT_PRECEDENCE[candidate.verdict]
    const winnerScore = VERDICT_PRECEDENCE[winner.verdict]
    // Higher precedence wins; on a tie prefer the candidate carrying a rule so
    // a real rule reason is shown over a thrown evaluator's generic fail-closed message.
    if (candidateScore > winnerScore || (candidateScore === winnerScore && candidate.rule && !winner.rule)) {
      winner = candidate
    }
  }
  return { winner, deniedBy, errors }
}

/** Build an evaluator verdict from a single matched rule (with its reason message). */
export function verdictForRule(rule: GuardRule): EvaluatorVerdict {
  switch (rule.type) {
    case "deny": return { verdict: "deny", rule, message: denyMsg(rule) }
    case "review": return { verdict: "review", rule, message: reviewMsg(rule) }
    case "warn": return { verdict: "warn", rule, message: warnMsg(rule) }
    case "allow": return { verdict: "allow", rule, message: allowMsg(rule) }
  }
}

/**
 * Resolve a candidate verdict into an effect using policy mode and the base
 * effect. Shared by the legacy `decide()` and the evaluator path so both keep
 * identical monitor_only / enforce semantics.
 */
function resolveEffect(
  policy: GuardPolicy,
  candidate: EvaluatorVerdict,
  baseEffect: BaseEffect,
  deniedBy: string[],
  errored: string[],
): DecisionOutcome {
  const mode = policy.settings.mode
  const rule = candidate.rule ?? null
  const message = candidate.message ?? ""
  const meta = { rule, deniedBy, errored }
  switch (candidate.verdict) {
    case "allow":
      if (mode === "enforce" && baseEffect === "ask") {
        return { ...meta, effect: "allow", decision: "allowed", message }
      }
      return { ...meta, effect: undefined, decision: "allowed", message }
    case "warn":
      return { ...meta, effect: undefined, decision: "warned", message }
    case "review":
      if (mode === "enforce" && baseEffect === "allow") {
        return { ...meta, effect: "ask", decision: "review", message }
      }
      return { ...meta, effect: undefined, decision: "review", message }
    case "deny":
      if (mode === "enforce") return { ...meta, effect: "deny", decision: "denied", message }
      return { ...meta, effect: undefined, decision: "would_denied", message }
    default:
      return { ...meta, effect: undefined, decision: "passthrough", rule: null, message: "" }
  }
}

/**
 * Applies the decision matrix for one matched-rules evaluation.
 * monitor_only never mutates effects (shadow mode labels `would_denied`);
 * enforce maps deny→deny, review→ask (raised from allow), allow→allow (relaxed from ask).
 * Kept for backwards compatibility; the runtime guard uses the evaluator path.
 */
export function decide(policy: GuardPolicy, matched: GuardRule[], baseEffect: BaseEffect): DecisionOutcome {
  const rule = topRule(matched)
  if (!rule) return { effect: undefined, decision: "passthrough", rule: null, message: "", deniedBy: [], errored: [] }
  return resolveEffect(policy, verdictForRule(rule), baseEffect, rule.type === "deny" ? [rule.id] : [], [])
}

/**
 * Evaluator-based decision path: aggregates every evaluator's candidate with
 * per-evaluator fail-closed semantics, then resolves through the same matrix
 * as `decide()` so mode/baseEffect behaviour is unchanged.
 */
export function decideFromEvaluators(
  policy: GuardPolicy,
  evaluators: readonly GuardEvaluator[],
  baseEffect: BaseEffect,
): DecisionOutcome {
  const aggregate = runEvaluators(evaluators)
  return resolveEffect(
    policy,
    aggregate.winner,
    baseEffect,
    aggregate.deniedBy,
    aggregate.errors.map((e) => e.evaluator),
  )
}

/** Behavior when the guard's own decision path throws outside an evaluator. */
export function failDecide(failMode: GuardFailMode, err: unknown): DecisionOutcome {
  const detail = err instanceof Error ? err.message : String(err)
  const meta = { rule: null, deniedBy: [], errored: [] }
  if (failMode === "fail_closed") {
    return {
      ...meta,
      effect: "deny",
      decision: "degraded",
      message: `otel.guard: internal error, fail_closed: ${detail}`,
    }
  }
  return {
    ...meta,
    effect: undefined, // keep base effect
    decision: "degraded",
    message: `otel.guard: internal error, fail_open: ${detail}`,
  }
}

function denyMsg(r: GuardRule) {
  return `otel.guard: denied by ${r.id} (${r.name}, severity=${r.severity})`
}
function reviewMsg(r: GuardRule) {
  return `otel.guard: review requested by ${r.id} (${r.name}, severity=${r.severity})`
}
function warnMsg(r: GuardRule) {
  return `otel.guard: warned by ${r.id} (${r.name}, severity=${r.severity})`
}
function allowMsg(r: GuardRule) {
  return `otel.guard: allowed by ${r.id} (${r.name})`
}
