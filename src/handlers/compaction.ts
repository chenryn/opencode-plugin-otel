import { SeverityNumber } from "@opentelemetry/api-logs"
import { SpanStatusCode } from "@opentelemetry/api"
import type { EventOf, HandlerContext } from "../types.ts"
import { compactionAttrs, costAttrs, errorAttrs, signalAttrs } from "../semconv.ts"
import { errorSummary, isTraceEnabled, resolveRunContext, setBoundedMap } from "../util.ts"

/** Records the summary text produced by a compaction, bounded like other content fields. */
const COMPACTION_OUTPUT_LIMIT = 20_000

/**
 * Starts a compaction span for the session. Context compaction is a model call that rewrites
 * the conversation, so it is traced alongside LLM steps instead of disappearing from the
 * timeline while the model's context silently changes.
 */
export function handleCompactionStarted(e: EventOf<"session.compaction.started">, ctx: HandlerContext) {
  const { sessionID, reason, recent } = e.data
  setBoundedMap(ctx.tracing.compactionMeta, sessionID, { startMs: e.created, reason })
  if (!isTraceEnabled("llm", ctx)) return
  const span = ctx.tracer.startSpan(`${ctx.tracePrefix}compaction`, {
    startTime: e.created,
    attributes: {
      "compaction.reason": reason,
      "compaction.recent_length": recent.length,
      ...ctx.commonAttrs,
    },
  }, resolveRunContext(sessionID, ctx))
  setBoundedMap(ctx.tracing.compactionSpans, sessionID, span)
}

/** Ends the compaction span with usage, cost, and (content-gated) summary output. */
export function handleCompactionEnded(e: EventOf<"session.compaction.ended">, ctx: HandlerContext) {
  const { sessionID, reason, text } = e.data
  const meta = ctx.tracing.compactionMeta.get(sessionID)
  const span = ctx.tracing.compactionSpans.get(sessionID)
  const durationMs = Math.max(0, e.created - (meta?.startMs ?? e.created))
  const output = ctx.captureContent && text ? text.slice(0, COMPACTION_OUTPUT_LIMIT) : undefined
  if (span) {
    span.setAttributes(compactionAttrs(ctx.semconv, {
      reason,
      durationMs,
      ...(e.data.tokens ? { tokens: e.data.tokens } : {}),
      ...(e.data.cost !== undefined ? { cost: e.data.cost } : {}),
      ...(output ? { output } : {}),
    }))
    span.setStatus({ code: SpanStatusCode.OK })
    span.end(e.created)
  }
  ctx.tracing.compactionSpans.delete(sessionID)
  ctx.tracing.compactionMeta.delete(sessionID)

  emitCompaction(e.created, sessionID, ctx, {
    reason,
    durationMs,
    success: true,
    ...(e.data.tokens ? { tokens: e.data.tokens } : {}),
    ...(e.data.cost !== undefined ? { cost: e.data.cost } : {}),
    ...(output ? { output } : {}),
  })
}

/** Ends a failed compaction span and reports the structured error. */
export function handleCompactionFailed(e: EventOf<"session.compaction.failed">, ctx: HandlerContext) {
  const { sessionID, reason, error } = e.data
  const meta = ctx.tracing.compactionMeta.get(sessionID)
  const span = ctx.tracing.compactionSpans.get(sessionID)
  const durationMs = Math.max(0, e.created - (meta?.startMs ?? e.created))
  if (span) {
    span.setAttributes(compactionAttrs(ctx.semconv, {
      reason,
      durationMs,
      ...(e.data.tokens ? { tokens: e.data.tokens } : {}),
      ...(e.data.cost !== undefined ? { cost: e.data.cost } : {}),
    }))
    span.setAttributes(errorAttrs(error))
    span.setStatus({ code: SpanStatusCode.ERROR, message: errorSummary(error) })
    span.end(e.created)
  }
  ctx.tracing.compactionSpans.delete(sessionID)
  ctx.tracing.compactionMeta.delete(sessionID)

  emitCompaction(e.created, sessionID, ctx, {
    reason,
    durationMs,
    success: false,
    error,
    ...(e.data.tokens ? { tokens: e.data.tokens } : {}),
  })
}

function emitCompaction(
  timestamp: number,
  sessionID: string,
  ctx: HandlerContext,
  input: {
    reason: string
    durationMs: number
    success: boolean
    error?: { type: string; message: string; status?: number }
    tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    cost?: number
    output?: string
  },
) {
  ctx.emitEvent({
    severityNumber: input.success ? SeverityNumber.INFO : SeverityNumber.ERROR,
    severityText: input.success ? "INFO" : "ERROR",
    timestamp,
    observedTimestamp: Date.now(),
    body: "compaction",
    attributes: {
      "event.name": "compaction",
      "session.id": sessionID,
      ...signalAttrs(ctx.semconv, { sessionID }),
      "compaction.reason": input.reason,
      duration_ms: input.durationMs,
      success: input.success,
      ...(input.tokens
        ? {
            input_tokens: input.tokens.input,
            output_tokens: input.tokens.output,
            reasoning_tokens: input.tokens.reasoning,
            cache_read_tokens: input.tokens.cache.read,
            cache_creation_tokens: input.tokens.cache.write,
          }
        : {}),
      ...costAttrs(ctx.semconv, input.cost ?? 0),
      ...(input.output ? { output_size: input.output.length } : {}),
      ...(input.error ? errorAttrs(input.error) : {}),
      ...(input.error ? { error: errorSummary(input.error) } : {}),
      ...ctx.commonAttrs,
    },
  })
}
