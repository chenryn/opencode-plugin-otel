// otel.guard — tool.execute.before / execute.after hook handlers.
//
// OpenCode v2 exposes these as mutable single-object hooks (`ctx.tool.hook`), with
// the tool name, session/agent/message/call ids, structured `input`, and on
// completion a mutable `result` or an `error`. The before hook stages structured
// arguments for the later `permission.evaluate` decision and checks a positive
// allowlist; the after hook redacts known secrets from tool output before the
// model sees it and records failed calls. Everything is opt-in and fail-open:
// hook errors are logged but never change the tool result.

import { SeverityNumber } from "@opentelemetry/api-logs"
import type { SpanContext } from "@opentelemetry/api"
import type { KeyObject } from "node:crypto"
import { checkAllowlist, type AllowlistHolder } from "./allowlist.ts"
import { computeArgsDigest, type AuditPrincipal, type AuditEntryInput } from "./audit.ts"
import { createToolState, consumeToolCall, peekToolCall, stageToolCall, toolInputText, type ToolState } from "./tool-state.ts"
import { redactContent, scanSecrets } from "./redact.ts"
import { effectiveGuardSettings, type GuardTelemetry } from "./guard.ts"
import type { GuardConfig } from "../config.ts"
import type { OpenCodeContext, PluginLogger } from "../types.ts"
import { getSessionAgentMeta, isMetricEnabled, sessionSpanContext } from "../util.ts"
import { signalAttrs } from "../semconv.ts"

/** Minimal shape of a `tool.execute.before` event. */
export type BeforeEvent = {
  tool: string
  sessionID: string
  agent?: string
  messageID?: string
  id: string
  input: unknown
}

/** Minimal shape of a `tool.execute.after` event (discriminated by status). */
export type AfterEvent = {
  tool: string
  sessionID: string
  agent?: string
  messageID?: string
  id: string
  input: unknown
  status: "completed" | "error"
  result?: { content?: unknown; output?: unknown; metadata?: Record<string, unknown> }
  error?: { message?: string; [key: string]: unknown }
}

/** Dependencies shared with the permission.evaluate guard hook. */
export type ToolHookContext = {
  config: GuardConfig
  policyVersion: () => string | undefined
  allowlist: AllowlistHolder
  hmacKey: KeyObject | null
  principal: AuditPrincipal | undefined
  auditEnabled: boolean
  recordAudit: (entry: AuditEntryInput) => void
  telemetry: GuardTelemetry
  log: PluginLogger
  /** State shared with the permission.evaluate hook to correlate staged args. */
  state: ToolState
}

const MAX_ERROR_EXCERPT = 300

/**
 * Register the v2 tool hooks. Returns a disposer; hook registrations live for
 * the plugin lifetime. Missing `ctx.tool.hook` (older OpenCode) is a soft skip.
 */
export async function setupToolHooks(
  ctx: OpenCodeContext,
  deps: ToolHookContext,
): Promise<() => Promise<void>> {
  if (!ctx.tool || typeof ctx.tool.hook !== "function") {
    await deps.log("warn", "guard: ctx.tool.hook unavailable; tool hooks inactive")
    return async () => {}
  }

  const before = async (event: BeforeEvent): Promise<void> => {
    const started = Date.now()
    const callID = String(event.id ?? "")
    try {
      const digest = computeArgsDigest(event.input, { hmacKey: deps.hmacKey })
      const staged: Parameters<typeof stageToolCall>[1] = {
        callID,
        tool: String(event.tool ?? ""),
        sessionID: String(event.sessionID ?? ""),
        agent: event.agent,
        messageID: event.messageID,
        input: event.input,
        digest,
        stagedAt: started,
      }
      stageToolCall(deps.state, staged)

      const verdict = checkAllowlist(deps.allowlist.allowlist, staged.tool, event.input)
      if (verdict.kind === "denied") {
        // The before hook cannot deny by itself; flag the staged call so the
        // permission.evaluate evaluator can turn this into a real deny decision.
        staged.allowlistDenial = verdict.reason
      }
      await emitToolEvent(deps, "guard.tool.before", started, {
        tool: staged.tool,
        callID,
        sessionID: staged.sessionID,
        agent: staged.agent,
        argsDigest: digest.argsDigest,
        argsDigestAlg: digest.argsDigestAlg,
        ...(digest.argsTruncated ? { argsTruncated: true } : {}),
        allowlist: verdict.kind,
        ...(verdict.kind === "denied" ? { allowlistReason: verdict.reason } : {}),
      })
      countAction(deps, "staged", staged.tool, verdict.kind === "denied" ? "allowlist_denied" : undefined)
    } catch (e) {
      await deps.log("debug", "guard: tool before hook error", { error: e instanceof Error ? e.message : String(e) })
    }
  }

  const after = async (event: AfterEvent): Promise<void> => {
    const started = Date.now()
    const callID = String(event.id ?? "")
    const tool = String(event.tool ?? "")
    const { mode } = effectiveGuardSettings(deps.config, null)
    let matches: string[] = []
    try {
      consumeToolCall(deps.state, callID)
      if (event.status === "error") {
        const message = typeof event.error?.message === "string" ? event.error.message.slice(0, MAX_ERROR_EXCERPT) : ""
        if (deps.auditEnabled) {
          deps.recordAudit({
            action: `tool.error:${tool}`,
            agentId: `opencode:${event.sessionID}`,
            decision: "tool_error",
            policyVersion: deps.policyVersion(),
            ...(message ? { reason: message } : {}),
            ...(deps.principal ? { principal: deps.principal } : {}),
          })
        }
        await emitToolEvent(deps, "guard.tool.after", started, {
          tool, callID, sessionID: event.sessionID, agent: event.agent, status: "error",
          ...(message ? { errorExcerpt: message } : {}),
        })
        countAction(deps, "tool_error", tool)
        return
      }

      // completed: scan output even when redaction is off (advisory signal)
      const result = event.result
      const content = result?.content
      let redacted: ReturnType<typeof redactContent> | undefined
      if (typeof content === "string" || Array.isArray(content)) {
        matches = scanContent(content)
        if (deps.config.guardToolRedact && mode === "enforce" && matches.length) {
          redacted = redactContent(content as string | Array<{ type: string; text?: string }>)
          // v2 result fields are readonly on Tool.Result but the event's `result`
          // property is mutable; replace the whole object rather than mutating.
          event.result = {
            ...(result ?? {}),
            ...(redacted.content !== undefined ? { content: redacted.content } : {}),
          }
          matches = redacted.matches
        }
      }
      if (deps.auditEnabled && matches.length) {
        deps.recordAudit({
          action: `tool.output:${tool}`,
          agentId: `opencode:${event.sessionID}`,
          decision: redacted ? "redacted" : "would_redact",
          policyVersion: deps.policyVersion(),
          reason: matches.join(","),
          ...(deps.principal ? { principal: deps.principal } : {}),
        })
      }
      await emitToolEvent(deps, "guard.tool.after", started, {
        tool, callID, sessionID: event.sessionID, agent: event.agent, status: "completed",
        secretPatterns: matches,
        redacted: !!redacted,
      })
      if (redacted) countAction(deps, "redacted", tool)
    } catch (e) {
      await deps.log("debug", "guard: tool after hook error", { error: e instanceof Error ? e.message : String(e) })
    }
  }

  await ctx.tool.hook("execute.before", before as never)
  await ctx.tool.hook("execute.after", after as never)
  await deps.log("info", "guard: tool.execute.before/after hooks registered", {
    allowlist: deps.allowlist.allowlist ? deps.allowlist.allowlist.sourcePath : "none",
    redact: deps.config.guardToolRedact,
  })
  return async () => {}
}

/**
 * Look up a staged call by the permission event's tool call id, if the event
 * carries one. Kept separate so the permission hook can enrich shell matching.
 */
export function stagedForPermission(state: ToolState, source: { type?: string; id?: string } | undefined): ReturnType<typeof peekToolCall> {
  if (!source || source.type !== "tool" || !source.id) return undefined
  return peekToolCall(state, source.id)
}

function scanContent(content: unknown): string[] {
  if (typeof content === "string") return scanSecrets(content)
  if (!Array.isArray(content)) return []
  const out = new Set<string>()
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string") {
      for (const id of scanSecrets((part as { text: string }).text)) out.add(id)
    }
  }
  return [...out]
}

async function emitToolEvent(
  deps: ToolHookContext,
  body: "guard.tool.before" | "guard.tool.after",
  timestamp: number,
  attributes: Record<string, unknown>,
): Promise<void> {
  const hctx = deps.telemetry?.hctx
  if (!hctx) return
  const sessionID = String(attributes["sessionID"] ?? "")
  const agentName = sessionID ? getSessionAgentMeta(sessionID, hctx).agentName : undefined
  const spanContext: SpanContext | undefined = sessionSpanContext(sessionID, hctx)
  hctx.emitEvent({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp,
    observedTimestamp: Date.now(),
    body,
    attributes: {
      "event.name": body,
      ...attributes,
      ...signalAttrs(hctx.semconv, {
        sessionID,
        agent: typeof attributes["agent"] === "string" ? attributes["agent"] : agentName,
        tool: typeof attributes["tool"] === "string" ? attributes["tool"] : undefined,
      }),
      ...hctx.commonAttrs,
    },
  }, spanContext)
}

function countAction(deps: ToolHookContext, action: string, tool: string, extra?: string): void {
  const hctx = deps.telemetry?.hctx
  if (!hctx || !isMetricEnabled("guard.tool.actions", hctx)) return
  hctx.instruments.guardToolActionsCounter.add(1, {
    "guard.tool.action": action,
    "tool_name": tool,
    ...(extra ? { "guard.tool.allowlist": extra } : {}),
    ...hctx.commonAttrs,
  })
}
