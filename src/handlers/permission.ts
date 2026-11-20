import { SeverityNumber } from "@opentelemetry/api-logs"
import type { SpanContext } from "@opentelemetry/api"
import type { EventOf, HandlerContext } from "../types.ts"
import { errorAttrs, signalAttrs } from "../semconv.ts"
import { getSessionAgentMeta, sessionSpanContext, setBoundedMap } from "../util.ts"

/** Largest number of permission resources retained on an event. */
const MAX_PERMISSION_RESOURCES = 32

type PermissionSource = { type?: string; messageID?: string; id?: string }

function sourceOf(source: PermissionSource | undefined): { toolCallID?: string; messageID?: string } {
  if (!source || source.type !== "tool") return {}
  return {
    ...(typeof source.id === "string" && source.id ? { toolCallID: source.id } : {}),
    ...(typeof source.messageID === "string" && source.messageID ? { messageID: source.messageID } : {}),
  }
}

/** Stores an answered permission prompt for correlation when the reply arrives. */
export function handlePermissionAsked(e: EventOf<"permission.asked">, ctx: HandlerContext) {
  const d = e.data
  const source = sourceOf((d as { source?: PermissionSource }).source)
  setBoundedMap(ctx.tracing.pendingPermissions, d.id, {
    action: d.action,
    resources: d.resources,
    sessionID: d.sessionID,
    ...source,
  })
  const { agentName, agentType, agentVersion } = getSessionAgentMeta(d.sessionID, ctx)
  const targetContext = targetSpanContext(source.toolCallID, ctx)
  ctx.emitEvent({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: e.created,
    observedTimestamp: Date.now(),
    body: "permission.requested",
    attributes: {
      "event.name": "permission.requested",
      ...signalAttrs(ctx.semconv, { sessionID: d.sessionID, agent: agentName, agentType, agentVersion, tool: d.action }),
      ...requestAttrs(d.id),
      "permission.action": d.action,
      "permission.resources": d.resources.slice(0, MAX_PERMISSION_RESOURCES),
      ...targetAttrs(source.toolCallID, targetContext),
      ...ctx.commonAttrs,
    },
  }, targetContext ?? sessionSpanContext(d.sessionID, ctx))
  void ctx.log("debug", "otel: permission asked", {
    requestID: d.id,
    sessionID: d.sessionID,
    action: d.action,
  })
}

/** Emits a `tool_decision` log event recording whether the permission was accepted or rejected. */
export function handlePermissionReplied(e: EventOf<"permission.replied">, ctx: HandlerContext) {
  const d = e.data
  const pending = ctx.tracing.pendingPermissions.get(d.requestID)
  ctx.tracing.pendingPermissions.delete(d.requestID)
  const decision = d.reply === "reject" ? "reject" : "accept"
  const { agentName, agentType, agentVersion } = getSessionAgentMeta(d.sessionID, ctx)
  const targetContext = targetSpanContext(pending?.toolCallID, ctx)

  ctx.emitEvent({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: e.created,
    observedTimestamp: Date.now(),
    body: "tool_decision",
    attributes: {
      "event.name": "tool_decision",
      ...signalAttrs(ctx.semconv, { sessionID: d.sessionID, agent: agentName, agentType, agentVersion, tool: pending?.action ?? "unknown" }),
      ...(pending?.action ? { "permission.action": pending.action } : {}),
      ...(pending ? resourcesAttrs(ctx, pending.resources) : {}),
      ...requestAttrs(d.requestID),
      ...targetAttrs(pending?.toolCallID, targetContext),
      decision,
      "permission.decision": decision,
      source: d.reply,
      ...(decision === "reject"
        ? errorAttrs({ type: "permission_denied", message: `${pending?.action ?? "unknown"} rejected` })
        : {}),
      ...ctx.commonAttrs,
    },
  }, targetContext ?? sessionSpanContext(d.sessionID, ctx))
}

function requestAttrs(id: string): Record<string, string> {
  return { "request.id": id }
}

function targetAttrs(toolCallID: string | undefined, context: SpanContext | undefined) {
  return {
    ...(toolCallID ? { "target.tool_call.id": toolCallID } : {}),
    ...(context ? { "target.span.id": context.spanId } : {}),
  }
}

function targetSpanContext(toolCallID: string | undefined, ctx: HandlerContext): SpanContext | undefined {
  return toolCallID ? ctx.tracing.toolSpanContexts.get(toolCallID) : undefined
}

/** Resources are an array in the GenAI dialect; the legacy comma-joined key stays for OpenInference. */
function resourcesAttrs(ctx: HandlerContext, resources: readonly string[]) {
  const bounded = resources.slice(0, MAX_PERMISSION_RESOURCES)
  return ctx.semconv === "gen_ai"
    ? { "permission.resources": bounded }
    : { resources: bounded.join(",") }
}
