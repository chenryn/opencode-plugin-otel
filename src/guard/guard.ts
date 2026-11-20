// otel.guard — runtime wiring for the permission.evaluate decision point.
//
// The guard is opt-in via the `guardEnabled` option (or OPENCODE_GUARD_ENABLED). When
// enabled it registers `ctx.permission.hook("evaluate")` — the single programmatic
// decision point in OpenCode v2 — and turns every evaluation into a structured
// `policy.decision` log event plus a `{prefix}guard.decisions` metric, reusing this
// plugin's OTel pipeline (LoggerProvider, flush scheduling, span correlation).
//
// Modes:
//  - monitor_only (default): never mutates effects; deny hits are labelled `would_denied`.
//  - enforce: deny→deny, review→ask (raised from allow), allow→allow (relaxed from ask).
//
// The decision path never throws and never awaits telemetry: observability failures
// must not affect enforcement.

import { SeverityNumber } from "@opentelemetry/api-logs"
import type { SpanContext } from "@opentelemetry/api"
import { createHash, createSecretKey, type KeyObject } from "node:crypto"
import { matchRules, makePolicyHolder, topRule, type GuardEvaluateEvent, type GuardPolicy, type GuardRule } from "./policy.ts"
import { decideFromEvaluators, failDecide, verdictForRule, type BaseEffect, type Decision, type DecisionOutcome, type GuardEvaluator } from "./decide.ts"
import { analyzeShell, extractCommand } from "./shell.ts"
import { appendAuditEntry, computeArgsDigest, getAuditStatus, type AuditPrincipal } from "./audit.ts"
import { makeAllowlistHolder } from "./allowlist.ts"
import { createToolState, isShellTool, toolInputText, type ToolState } from "./tool-state.ts"
import { setupToolHooks, stagedForPermission } from "./tool-hooks.ts"
import { handlePromptInjection, type PromptInjectionOptions } from "./prompt-injection-hook.ts"
import type { GuardConfig } from "../config.ts"
import type { HandlerContext, OpenCodeContext, PluginLogger } from "../types.ts"
import { getSessionAgentMeta, isMetricEnabled, sessionSpanContext } from "../util.ts"
import { errorAttrs, signalAttrs } from "../semconv.ts"

/** Largest resource excerpt retained on a decision event. */
const MAX_RESOURCE_EXCERPT = 300
/** Largest rule list retained on a decision event. */
const MAX_RULES = 16
/** Minimum HMAC key length in bytes (shorter keys are refused). */
const MIN_HMAC_KEY_BYTES = 32

/** Resolved operator-scoped audit context; HMAC key is non-enumerable in logs. */
export type GuardAuditContext = {
  hmacKey: KeyObject | null
  principal: AuditPrincipal | undefined
  configError: string | undefined
}

/**
 * Resolve audit principal/HMAC from operator config only. A short HMAC key is
 * refused rather than silently weakened; principal fields are capped.
 */
export function resolveGuardAuditContext(config: GuardConfig): GuardAuditContext {
  const errors: string[] = []
  let hmacKey: KeyObject | null = null
  if (config.guardAuditHmacKey) {
    const bytes = Buffer.byteLength(config.guardAuditHmacKey, "utf8")
    if (bytes < MIN_HMAC_KEY_BYTES) {
      errors.push(`OPENCODE_GUARD_AUDIT_HMAC_KEY must be at least ${MIN_HMAC_KEY_BYTES} bytes, got ${bytes}`)
    } else {
      hmacKey = createSecretKey(config.guardAuditHmacKey, "utf8")
    }
  }
  const sub = config.guardPrincipalSub?.trim().slice(0, 256)
  if (config.guardPrincipalSub && !sub) errors.push("OPENCODE_GUARD_PRINCIPAL_SUB must be non-empty")
  const iss = config.guardPrincipalIss?.trim().slice(0, 256)
  if (config.guardPrincipalIss && !iss) errors.push("OPENCODE_GUARD_PRINCIPAL_ISS must be non-empty")
  const principal = sub ? { sub, ...(iss ? { iss } : {}) } : undefined
  return { hmacKey, principal, configError: errors.join(" ") || undefined }
}

/** Structural shape of a `permission.evaluate` hook event (see @opencode/plugin PermissionEvaluation). */
type EvaluateEvent = {
  sessionID: string
  agent?: string
  action: string
  resources: ReadonlyArray<unknown>
  source?: { type?: string; id?: string; messageID?: string }
  effect: "allow" | "ask" | "deny"
  message?: string
}

/** Telemetry dependencies the guard needs; `null` when the OTel SDK is disabled. */
export type GuardTelemetry = {
  hctx: HandlerContext
} | null

function sha256of(s: string): string {
  return `sha256:${createHash("sha256").update(s).digest("hex")}`
}

function excerpt(s: string, max = MAX_RESOURCE_EXCERPT): string {
  return s.length > max ? s.slice(0, max) : s
}

/** Resolves the effective mode/fail-mode: plugin option wins over the policy file settings. */
export function effectiveGuardSettings(config: GuardConfig, policy: GuardPolicy | null) {
  return {
    mode: config.guardMode ?? policy?.settings.mode ?? "monitor_only",
    failMode: config.guardFailMode ?? policy?.settings.fail_mode ?? "fail_open",
  }
}

function severityFor(decision: Decision): { severityNumber: SeverityNumber; severityText: string } {
  if (decision === "degraded") return { severityNumber: SeverityNumber.ERROR, severityText: "ERROR" }
  if (decision === "denied" || decision === "would_denied") return { severityNumber: SeverityNumber.WARN, severityText: "WARN" }
  return { severityNumber: SeverityNumber.INFO, severityText: "INFO" }
}

/** Builds the `policy.decision` log record attributes (otel.guard/v1 schema). */
export function policyDecisionAttributes(input: {
  policy: GuardPolicy | null
  matched: GuardRule[]
  outcome: DecisionOutcome
  baseEffect: BaseEffect
  event: EvaluateEvent
  mode: string
  shellCommand: string | null
  commonAttrs: Readonly<Record<string, string>>
}): Record<string, unknown> {
  const { policy, matched, outcome, baseEffect, event, mode, shellCommand, commonAttrs } = input
  const top = outcome.rule
  const commandHash = shellCommand ? sha256of(shellCommand) : undefined
  return {
    "event.name": "policy.decision",
    // session/agent/tool identity is added by the caller via signalAttrs
    "policy.decision": outcome.decision,
    "policy.mode": mode,
    "policy.base_effect": baseEffect,
    "policy.effect": outcome.effect ?? baseEffect,
    "policy.version_sha256": policy?.version_sha256 ?? "unloaded",
    "policy.matched_count": matched.length,
    ...(matched.length
      ? { "policy.matched_rules": matched.slice(0, MAX_RULES).map((r) => r.id) }
      : {}),
    ...(top
      ? {
          "policy.rule_id": top.id,
          "policy.rule_name": top.name,
          "policy.rule_type": top.type,
          "policy.rule_severity": top.severity,
        }
      : {}),
    ...(outcome.message ? { "policy.message": excerpt(outcome.message) } : {}),
    ...(outcome.deniedBy.length ? { "policy.denied_by": outcome.deniedBy } : {}),
    ...(outcome.errored.length ? { "policy.errored_evaluators": outcome.errored } : {}),
    ...(commandHash ? { "policy.command_hash": commandHash } : {}),
    "policy.resource_excerpt": excerpt(
      event.resources.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join(" "),
    ),
    ...commonAttrs,
  }
}

/**
 * Registers the guard on the OpenCode context. Returns a disposer (policy watcher is
 * non-persistent, so shutdown is a no-op beyond logging).
 */
export async function setupGuard(
  ctx: OpenCodeContext,
  config: GuardConfig,
  telemetry: GuardTelemetry,
  log: PluginLogger,
): Promise<() => Promise<void>> {
  if (!ctx?.permission || typeof ctx.permission.hook !== "function") {
    await log("warn", "guard: ctx.permission.hook unavailable, guard inactive")
    return async () => {}
  }
  if (telemetry === null) {
    await log("warn", "guard: telemetry disabled - decisions will be enforced and logged to the server console, but not exported")
  }

  const holder = makePolicyHolder(config.guardPolicyPath, (e) => {
    void log("warn", "guard: policy reload failed, keeping last good", {
      path: config.guardPolicyPath,
      error: e instanceof Error ? e.message : String(e),
    })
  })
  const initial = holder.policy
  await log("info", "guard: policy loaded", {
    path: config.guardPolicyPath,
    rules: initial?.rules.length ?? 0,
    version_sha256: initial?.version_sha256 ?? "none",
    mode: effectiveGuardSettings(config, initial).mode,
    failMode: effectiveGuardSettings(config, initial).failMode,
  })

  const audit = resolveGuardAuditContext(config)
  if (audit.configError) {
    await log("error", "guard: audit configuration invalid - audit disabled", { error: audit.configError })
  }
  const auditEnabled = config.guardAuditEnabled && !audit.configError
  if (auditEnabled) {
    const status = await getAuditStatus(config.guardAuditPath)
    await log(status.valid ? "info" : "error", "guard: audit status", {
      path: config.guardAuditPath, entries: status.count, valid: status.valid,
      ...(status.error ? { error: status.error } : {}),
    })
  }

  // P5: optional tool hooks share the same state/audit pipeline. A missing
  // allowlist file is normal (the feature is opt-in by file presence) so it
  // logs at debug rather than error.
  const toolState: ToolState = createToolState()
  const allowlist = makeAllowlistHolder(config.guardToolAllowlistPath, (e) => {
    void log("debug", "guard: allowlist not active", {
      path: config.guardToolAllowlistPath,
      error: e instanceof Error ? e.message : String(e),
    })
  })
  if (allowlist.allowlist) {
    await log("info", "guard: tool allowlist loaded", {
      path: config.guardToolAllowlistPath,
      tools: allowlist.allowlist.rules.size,
      version_sha256: allowlist.allowlist.versionSha256,
    })
  }
  // Serialize audit writes without awaiting them on the decision path: a chain
  // append must observe the previous append's hash, and fs errors must never
  // affect enforcement.
  let auditQueue = Promise.resolve()
  const recordAudit = (input: Parameters<typeof appendAuditEntry>[1]) => {
    if (!auditEnabled) return
    auditQueue = auditQueue.then(async () => {
      await appendAuditEntry(config.guardAuditPath, input)
    }, async () => {
      await appendAuditEntry(config.guardAuditPath, input)
    }).catch((e: unknown) => {
      void log("error", "guard: audit append failed", { error: e instanceof Error ? e.message : String(e) })
    })
  }

  let evaluations = 0
  const metricName = "guard.decisions"

  await ctx.permission.hook("evaluate", async (event) => {
    evaluations++
    const started = Date.now()
    const baseEffect = event.effect
    const policy = holder.policy
    const { mode, failMode } = effectiveGuardSettings(config, policy)
    // P5a: correlate the tool call staged by execute.before (v2 hooks run before
    // permission.assert). Structured args give a faithful command for shell
    // analysis and let the allowlist evaluator deny with real arguments.
    const staged = stagedForPermission(toolState, event.source)
    const stagedText = staged ? toolInputText(staged.tool, staged.input) : null
    const evaluateEvent = stagedText
      ? { ...event, resources: [stagedText, ...event.resources] }
      : event
    const shellCommand = staged && isShellTool(staged.tool) && stagedText
      ? stagedText
      : extractCommand(event)
    let matched: GuardRule[] = []
    let outcome: DecisionOutcome

    try {
      if (!policy) throw new Error("policy not loaded")
      const policyForDecide: GuardPolicy = {
        ...policy,
        settings: { ...policy.settings, mode: mode as GuardPolicy["settings"]["mode"], fail_mode: failMode },
      }
      // Each evaluator is isolated: a throw becomes a deny candidate without
      // hiding other evaluators.
      const evaluators: GuardEvaluator[] = [
        {
          id: "rules",
          evaluate: () => {
            const matched = matchRules(policyForDecide, evaluateEvent)
            const rule = topRule(matched)
            return rule ? verdictForRule(rule) : { verdict: "passthrough" }
          },
        },
      ]
      if (staged?.allowlistDenial) {
        evaluators.push({
          id: "tool-allowlist",
          evaluate: () => ({ verdict: "deny", message: staged.allowlistDenial }),
        })
      }
      matched = matchRules(policyForDecide, evaluateEvent) // retained for telemetry attributes
      outcome = decideFromEvaluators(policyForDecide, evaluators, baseEffect)
    } catch (e) {
      outcome = failDecide(failMode, e)
      await log("error", "guard: decision path error", {
        error: e instanceof Error ? e.message : String(e),
      })
    }

    // apply the effect only when the decision says to change it
    if (outcome.effect) {
      event.effect = outcome.effect
      if (outcome.message) event.message = outcome.message
    }

    const decision = outcome.decision

    // audit evidence — recorded independently of telemetry so passthrough
    // suppression or exporter failures can never drop a chain link
    if (auditEnabled) {
      try {
        // Prefer the structured arguments staged by execute.before: they carry
        // the real typed payload rather than the flattened resource strings.
        const digest = staged
          ? staged.digest
          : computeArgsDigest(event.resources, { hmacKey: audit.hmacKey })
        recordAudit({
          action: event.action,
          agentId: `opencode:${event.sessionID}`,
          decision,
          policyVersion: policy?.version_sha256,
          ...(outcome.message ? { reason: excerpt(outcome.message, 1024) } : {}),
          ...digest,
          ...(audit.principal ? { principal: audit.principal } : {}),
        })
      } catch (e) {
        void log("error", "guard: audit record preparation failed", { error: e instanceof Error ? e.message : String(e) })
      }
    }

    // observability: never let telemetry break the decision path
    try {
      const hctx = telemetry?.hctx
      if (hctx) {
        // unmatched evaluations are skipped when the operator opted out of passthrough noise
        if (outcome.decision === "passthrough" && !config.guardEmitUnmatched) return
        const source = event.source
        const callID = source?.type === "tool" && source.id ? source.id : undefined
        const targetContext: SpanContext | undefined = callID
          ? hctx.tracing.toolSpanContexts.get(callID)
          : undefined
        const { agentName, agentType, agentVersion } = getSessionAgentMeta(event.sessionID, hctx)
        const severity = severityFor(decision)
        hctx.emitEvent({
          severityNumber: severity.severityNumber,
          severityText: severity.severityText,
          timestamp: started,
          observedTimestamp: Date.now(),
          body: "policy.decision",
          attributes: {
            ...policyDecisionAttributes({
              policy,
              matched,
              outcome,
              baseEffect,
              event,
              mode,
              shellCommand,
              commonAttrs: hctx.commonAttrs,
            }),
            ...signalAttrs(hctx.semconv, {
              sessionID: event.sessionID,
              agent: agentName,
              agentType,
              agentVersion,
              tool: event.action,
            }),
            ...(callID ? { "target.tool_call.id": callID } : {}),
            ...(targetContext ? { "target.span.id": targetContext.spanId } : {}),
            ...(shellCommand
              ? (() => {
                  const shellInfo = analyzeShell(shellCommand)
                  return {
                    "shell.obfuscated": shellInfo.obfuscated,
                    "shell.atoms_count": shellInfo.atoms_count,
                    ...(shellInfo.dangerous_ops.length ? { "shell.dangerous_ops": shellInfo.dangerous_ops } : {}),
                    ...(shellInfo.injection_patterns.length ? { "shell.injection_patterns": shellInfo.injection_patterns } : {}),
                    ...(shellInfo.zero_width ? { "shell.zero_width": true } : {}),
                    ...(shellInfo.homoglyph ? { "shell.homoglyph": true } : {}),
                    ...(shellInfo.safe_cleanup ? { "shell.safe_cleanup": true } : {}),
                  }
                })()
              : {}),
            ...(decision === "degraded" ? errorAttrs({ type: "guard_degraded", message: outcome.message }) : {}),
            ...(auditEnabled
              ? {
                  "guard.audit": true,
                  "guard.audit.digest_alg": audit.hmacKey ? "hmac-sha256" : "sha256",
                  ...(audit.principal ? { "guard.principal.sub": audit.principal.sub } : {}),
                }
              : {}),
          },
        }, targetContext ?? sessionSpanContext(event.sessionID, hctx))
        if (isMetricEnabled(metricName, hctx)) {
          hctx.instruments.guardDecisionsCounter.add(1, {
            "policy.decision": decision,
            "policy.mode": mode,
            "permission.action": event.action,
            ...(outcome.rule ? { "policy.rule_id": outcome.rule.id } : {}),
            ...(outcome.deniedBy.length ? { "policy.denied_by": outcome.deniedBy.join(",") } : {}),
            ...hctx.commonAttrs,
          })
        }
      }
      await log(
        decision === "degraded" || decision === "denied" || decision === "would_denied" ? "warn" : "debug",
        `guard: ${decision}`,
        {
          evaluation: evaluations,
          action: event.action,
          base: baseEffect,
          effect: event.effect,
          rules: matched.map((r) => r.id),
          mode,
          sessionID: event.sessionID,
          durationMs: Date.now() - started,
        },
      )
    } catch (e) {
      // telemetry must never break enforcement
      try {
        await log("debug", "guard: telemetry error", {
          error: e instanceof Error ? e.message : String(e),
        })
      } catch {
        /* ignore */
      }
    }
  })

  await log("info", "guard: permission.evaluate hook registered")

  let toolTeardown: (() => Promise<void>) | null = null
  if (config.guardToolHooks) {
    toolTeardown = await setupToolHooks(ctx, {
      config,
      policyVersion: () => holder.policy?.version_sha256,
      allowlist,
      hmacKey: audit.hmacKey,
      principal: audit.principal,
      auditEnabled,
      recordAudit,
      telemetry,
      log,
      state: toolState,
    })
  }

  // User-prompt injection blocking (opt-in). Registered here so guard-only mode
  // (telemetry disabled) still enforces; the throw propagates through v2's
  // session.prompt hook and stops the request reaching the model.
  if (config.guardPromptInjectionBlock) {
    const options: PromptInjectionOptions = {
      block: true,
      mode: effectiveGuardSettings(config, holder.policy).mode === "enforce" ? "enforce" : "monitor_only",
      minSeverity: config.guardPromptInjectionMinSeverity,
      failMode: effectiveGuardSettings(config, holder.policy).failMode,
    }
    await ctx.session.hook("prompt", async (event) => {
      await handlePromptInjection(event as never, telemetry, options, log)
    })
    await log("info", "guard: session.prompt injection hook registered", {
      mode: options.mode,
      minSeverity: options.minSeverity,
      failMode: options.failMode,
    })
  }

  return async () => {
    if (toolTeardown) await toolTeardown()
  }
}
