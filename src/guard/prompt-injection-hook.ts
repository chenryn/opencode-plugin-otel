// otel.guard — session.prompt injection hook handler.
//
// Scans USER prompt text for attack signatures and can block the request before
// it reaches the model. This is intentionally separate from `prompt-defense.ts`
// (system-prompt coverage, advisory only): blocking on defense coverage would
// deny every normal request, which scores 0/12. Blocking requires an explicit
// opt-in (`guardPromptInjectionBlock`) AND enforce mode; advisory mode always
// only logs. No prompt text is ever recorded — only a hash and finding ids.

import { SeverityNumber } from "@opentelemetry/api-logs"
import { isInjectionBlocking, scanPromptInjection, type InjectionSeverity } from "./prompt-injection.ts"
import { signalAttrs } from "../semconv.ts"
import type { GuardTelemetry } from "./guard.ts"
import type { GuardFailModeOption } from "../config.ts"
import type { PluginLogger } from "../types.ts"
import { getSessionAgentMeta, sessionSpanContext } from "../util.ts"

/** Minimal shape of a `session.prompt` hook event used here. */
export type PromptEvent = {
  sessionID: string
  messageID?: string
  prompt?: { text?: string; [key: string]: unknown }
  metadata?: Record<string, unknown>
}

/** Options controlling injection scan and blocking behavior. */
export type PromptInjectionOptions = {
  /** When false, scan is advisory only: findings are logged, never block. */
  block: boolean
  /** `enforce` enables blocking; `monitor_only` never blocks. */
  mode: "monitor_only" | "enforce"
  /** At or above this severity a finding blocks (when block+enforce). */
  minSeverity: InjectionSeverity
  /** On a scanning error, `fail_closed` blocks and `fail_open` logs only. */
  failMode: GuardFailModeOption
}

/** Error thrown to block a prompt; message is safe (no prompt content). */
export class PromptInjectionBlocked extends Error {
  constructor(findingIds: string[]) {
    super(`otel.guard: prompt blocked by injection detection (${findingIds.join(",") || "obfuscation"})`)
    this.name = "PromptInjectionBlocked"
  }
}

/**
 * Scan a submitted prompt and, when explicitly enabled in enforce mode, throw
 * {@link PromptInjectionBlocked} to stop it reaching the model. Telemetry and
 * logging failures are swallowed; a scanning error follows `failMode`.
 */
export async function handlePromptInjection(
  event: PromptEvent,
  telemetry: GuardTelemetry,
  options: PromptInjectionOptions,
  log: PluginLogger,
): Promise<void> {
  const text = typeof event.prompt?.text === "string" ? event.prompt.text : ""
  let report
  try {
    report = scanPromptInjection(text)
  } catch (e) {
    // Scanning itself should never fail on normal text, but honour failMode.
    const detail = e instanceof Error ? e.message : String(e)
    await log("error", "guard: prompt injection scan error", { error: detail, failMode: options.failMode })
    if (options.block && options.mode === "enforce" && options.failMode === "fail_closed") {
      throw new PromptInjectionBlocked(["scan_error"])
    }
    return
  }

  if (!report.detected) return

  const shouldBlock = options.block && options.mode === "enforce" && isInjectionBlocking(report, options.minSeverity)
  const severity = report.highestSeverity ?? "medium"
  await emit(event, telemetry, report.promptHash, report.findings.map((f) => f.id), severity, {
    detected: true, patternCount: report.findings.length, zeroWidth: report.zeroWidth,
    homoglyph: report.homoglyph, blocked: shouldBlock, mode: options.mode,
  })
  await log(shouldBlock ? "warn" : "info", "guard: prompt injection finding", {
    sessionID: event.sessionID,
    findings: report.findings.map((f) => f.id),
    severity,
    blocked: shouldBlock,
  })

  if (shouldBlock) throw new PromptInjectionBlocked(report.findings.map((f) => f.id))
}

async function emit(
  event: PromptEvent,
  telemetry: GuardTelemetry,
  promptHash: string,
  findings: string[],
  severity: string,
  extra: Record<string, unknown>,
): Promise<void> {
  const hctx = telemetry?.hctx
  if (!hctx) return
  const { agentName, agentType } = getSessionAgentMeta(event.sessionID, hctx)
  hctx.emitEvent({
    severityNumber: extra["blocked"] ? SeverityNumber.WARN : SeverityNumber.INFO,
    severityText: extra["blocked"] ? "WARN" : "INFO",
    timestamp: Date.now(),
    body: "guard.prompt.injection",
    attributes: {
      "event.name": "guard.prompt.injection",
      "guard.prompt.hash": promptHash,
      "guard.prompt.findings": findings,
      "guard.prompt.severity": severity,
      ...extra,
      ...signalAttrs(hctx.semconv, {
        sessionID: event.sessionID,
        agent: agentName,
        agentType,
      }),
      ...hctx.commonAttrs,
    },
  }, sessionSpanContext(event.sessionID, hctx))
}
