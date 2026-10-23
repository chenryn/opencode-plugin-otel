import { SeverityNumber } from "@opentelemetry/api-logs"
import { SpanKind, SpanStatusCode } from "@opentelemetry/api"
import type { EventOf, HandlerContext } from "../types.ts"
import { signalAttrs, toolCallAttrs, toolEndAttrs, toolSpanName, toolStartAttrs } from "../semconv.ts"
import {
  errorSummary,
  getSessionAgentMeta,
  isMetricEnabled,
  isTraceEnabled,
  recordFirstToken,
  resolveStepContext,
  setBoundedMap,
} from "../util.ts"

const GIT_COMMIT_RE = /\bgit\s+commit(?![-\w])/
const SHELL_TOOL_RE = /(^|\.)(bash|shell)$/i

type ToolContent = { type: "text"; text: string } | { type: "file"; uri: string; mime: string; name?: string }

/** Records the tool name for correlation with its execution and terminal events. */
export function handleToolInputStarted(e: EventOf<"session.tool.input.started">, ctx: HandlerContext) {
  const d = e.data
  recordFirstToken(d.assistantMessageID, e.created, ctx)
  setBoundedMap(ctx.tracing.toolMeta, d.id, {
    sessionID: d.sessionID,
    assistantMessageID: d.assistantMessageID,
    tool: d.name,
    startMs: e.created,
  })
}

/** Starts timing and tracing an observed tool call, and retains the command for commit detection. */
export function handleToolCalled(e: EventOf<"session.tool.called">, ctx: HandlerContext) {
  const d = e.data
  const meta = ctx.tracing.toolMeta.get(d.id)
  if (!meta) return
  const isSubagent = meta.tool === "subagent"
  setBoundedMap(ctx.tracing.toolMeta, d.id, {
    ...meta,
    startMs: e.created,
    executionStarted: true,
    ...(isSubagent && typeof d.input["agent"] === "string" ? { agent: d.input["agent"] } : {}),
    ...(typeof d.input["command"] === "string" ? { command: d.input["command"] } : {}),
  })

  if (!isTraceEnabled("tool", ctx)) return
  if (isSubagent) startSubagentSpan(d.id, ctx)
  else {
    const span = ctx.tracer.startSpan(
      toolSpanName(ctx.semconv, meta.tool, ctx.tracePrefix),
      {
        startTime: e.created,
        kind: SpanKind.INTERNAL,
        attributes: {
          ...toolStartAttrs(ctx.semconv, { sessionID: d.sessionID, tool: meta.tool, callID: d.id }),
          ...ctx.commonAttrs,
        },
      },
      resolveStepContext(d.sessionID, d.assistantMessageID, ctx),
    )
    setBoundedMap(ctx.tracing.toolSpans, d.id, span)
    setBoundedMap(ctx.tracing.toolSpanContexts, d.id, span.spanContext())
  }

  const { agentName, agentType } = getSessionAgentMeta(d.sessionID, ctx)
  ctx.tracing.toolSpans.get(d.id)?.setAttributes(toolCallAttrs(ctx.semconv, {
    agent: agentName,
    agentType,
    inputJson: ctx.captureContent ? safeJson(d.input) : undefined,
    providerExecuted: isProviderExecuted(d),
  }))
}

type ProviderExecution = {
  readonly executed?: boolean
  readonly provider?: { readonly executed?: boolean }
}

function isProviderExecuted(data: ProviderExecution): boolean {
  return data.provider?.executed ?? data.executed ?? false
}

function startSubagentSpan(callID: string, ctx: HandlerContext) {
  const meta = ctx.tracing.toolMeta.get(callID)
  if (!meta || meta.tool !== "subagent") return
  setBoundedMap(ctx.tracing.toolMeta, callID, { ...meta, executionStarted: true })
  if (ctx.tracing.toolSpans.has(callID) || !isTraceEnabled("tool", ctx)) return
  const { agentName, agentType } = getSessionAgentMeta(meta.sessionID, ctx)
  const span = ctx.tracer.startSpan(
    toolSpanName(ctx.semconv, "subagent", ctx.tracePrefix),
    {
      startTime: meta.startMs,
      kind: SpanKind.INTERNAL,
      attributes: {
        ...toolStartAttrs(ctx.semconv, {
          sessionID: meta.sessionID,
          tool: "subagent",
          callID,
          agent: agentName,
          agentType,
          subagent: meta.agent ?? "unknown",
        }),
        ...ctx.commonAttrs,
      },
    },
    resolveStepContext(meta.sessionID, meta.assistantMessageID, ctx),
  )
  setBoundedMap(ctx.tracing.toolSpans, callID, span)
  setBoundedMap(ctx.tracing.toolSpanContexts, callID, span.spanContext())
}

function linkSubagent(callID: string, childID: unknown, ctx: HandlerContext) {
  const meta = ctx.tracing.toolMeta.get(callID)
  if (typeof childID !== "string" || meta?.tool !== "subagent" || ctx.tracing.consumedSubagentDispatches.has(callID)) return
  setBoundedMap(ctx.tracing.toolMeta, callID, { ...meta, childSessionID: childID })
  startSubagentSpan(callID, ctx)
  const span = ctx.tracing.toolSpans.get(callID)
  span?.setAttribute("subagent.session_id", childID)
  const spanContext = span?.spanContext()
  if (spanContext) setBoundedMap(ctx.tracing.subagentParents, childID, { spanContext, callID })
}

export function handleToolProgress(e: EventOf<"session.tool.progress">, ctx: HandlerContext) {
  linkSubagent(e.data.id, e.data.metadata["sessionID"], ctx)
}

/** Ends a successful tool call: records duration, sets output attributes, and emits `tool_result`. */
export function handleToolSuccess(e: EventOf<"session.tool.success">, ctx: HandlerContext) {
  linkSubagent(e.data.id, e.data.metadata?.["sessionID"], ctx)
  const output = contentText(e.data.content)
  finishTool(e.data.id, e.data.sessionID, e.created, true, output, undefined, ctx)
}

/** Ends a failed tool call: records duration, sets error attributes, and emits `tool_result`. */
export function handleToolFailed(e: EventOf<"session.tool.failed">, ctx: HandlerContext) {
  linkSubagent(e.data.id, e.data.metadata?.["sessionID"], ctx)
  const output = contentText(e.data.content)
  finishTool(e.data.id, e.data.sessionID, e.created, false, output, errorSummary(e.data.error), ctx)
}

function finishTool(
  callID: string,
  sessionID: string,
  endMs: number,
  success: boolean,
  output: string,
  error: string | undefined,
  ctx: HandlerContext,
) {
  const meta = ctx.tracing.toolMeta.get(callID)
  ctx.tracing.toolMeta.delete(callID)
  const tool = meta?.tool ?? "unknown"
  const observedExecution = meta?.executionStarted === true
  const start = observedExecution ? meta.startMs : endMs
  const durationMs = Math.max(0, endMs - start)
  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx)
  const sizeBytes = output ? Buffer.byteLength(output, "utf8") : 0

  if (success && observedExecution && meta.command && SHELL_TOOL_RE.test(tool) && GIT_COMMIT_RE.test(meta.command)) {
    if (isMetricEnabled("commit.count", ctx)) {
      ctx.instruments.commitCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID })
    }
    ctx.emitEvent({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      timestamp: endMs,
      observedTimestamp: Date.now(),
      body: "commit",
      attributes: {
        "event.name": "commit",
        ...signalAttrs(ctx.semconv, { sessionID, agent: agentName, agentType }),
        ...ctx.commonAttrs,
      },
    })
  }

  if (observedExecution && isMetricEnabled("tool.duration", ctx)) {
    ctx.instruments.toolDurationHistogram.record(durationMs, {
      ...ctx.commonAttrs,
      ...signalAttrs(ctx.semconv, { sessionID, tool }),
      success,
    })
  }

  const span = ctx.tracing.toolSpans.get(callID)
  if (span) {
    span.setAttributes(toolEndAttrs(ctx.semconv, {
      agent: agentName,
      agentType,
      success,
      sizeBytes,
      ...(output && ctx.captureContent ? { output } : {}),
      ...(success ? {} : { error: error ?? "unknown" }),
    }))
    if (success) {
      span.setStatus({ code: SpanStatusCode.OK })
    } else {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error ?? "unknown" })
    }
    span.end(endMs)
  }
  ctx.tracing.toolSpans.delete(callID)
  ctx.tracing.toolSpanContexts.delete(callID)

  ctx.emitEvent({
    severityNumber: success ? SeverityNumber.INFO : SeverityNumber.ERROR,
    severityText: success ? "INFO" : "ERROR",
    timestamp: start,
    observedTimestamp: Date.now(),
    body: "tool_result",
    attributes: {
      "event.name": "tool_result",
      ...signalAttrs(ctx.semconv, { sessionID, agent: agentName, agentType, tool }),
      success,
      duration_ms: durationMs,
      ...(success ? { tool_result_size_bytes: sizeBytes } : { error: error ?? "unknown" }),
      ...ctx.commonAttrs,
    },
  })
}

function contentText(content: readonly ToolContent[] | undefined): string {
  if (!content) return ""
  return content
    .map((part) => (part.type === "text" ? part.text : part.name ?? part.uri))
    .filter(Boolean)
    .join("\n")
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}
