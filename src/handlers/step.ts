import { SeverityNumber } from "@opentelemetry/api-logs"
import { SpanKind, SpanStatusCode } from "@opentelemetry/api"
import type { EventOf, HandlerContext, SessionTotals } from "../types.ts"
import { llmEndAttrs, llmFailAttrs, llmSpanName, llmStartAttrs } from "../semconv.ts"
import { ensureSession } from "./session.ts"
import { applyModelContext } from "./chat-headers.ts"
import {
  agentAttrs,
  errorSummary,
  genAiProviderName,
  isMetricEnabled,
  isTraceEnabled,
  markSeen,
  recordFirstToken,
  resolveRunContext,
  setBoundedMap,
} from "../util.ts"

function billedTokens(tokens: { input: number; output: number; reasoning: number } | undefined): number {
  return (tokens?.input ?? 0) + (tokens?.output ?? 0) + (tokens?.reasoning ?? 0)
}

function allTokens(tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } | undefined): number {
  if (!tokens) return 0
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

function accumulateTotals(
  sessionID: string,
  tokens: number,
  cost: number,
  incrementMessages: boolean,
  ctx: HandlerContext,
) {
  const existing = ctx.tracing.sessionTotals.get(sessionID)
  if (!existing) return
  const next: SessionTotals = {
    ...existing,
    tokens: existing.tokens + tokens,
    cost: existing.cost + cost,
    messages: existing.messages + (incrementMessages ? 1 : 0),
  }
  setBoundedMap(ctx.tracing.sessionTotals, sessionID, next)
}

/** Starts an LLM span for a step and records the model/agent metadata for the request. */
export function handleStepStarted(e: EventOf<"session.step.started">, ctx: HandlerContext) {
  const d = e.data
  const totals = ensureSession(d.sessionID, e.created, ctx)
  const agentType = totals.agentType
  setBoundedMap(ctx.tracing.stepMeta, d.assistantMessageID, {
    sessionID: d.sessionID,
    startMs: d.started ?? e.created,
    agent: d.agent,
    agentType,
    modelID: d.model.id,
    providerID: d.model.providerID,
  })
  if (totals && totals.agent !== d.agent) {
    setBoundedMap(ctx.tracing.sessionTotals, d.sessionID, { ...totals, agent: d.agent })
  }

  if (!isTraceEnabled("llm", ctx)) return
  const promptText = ctx.tracing.activePrompts.get(d.sessionID)?.text
  const attributes = {
    ...llmStartAttrs(ctx.semconv, {
      sessionID: d.sessionID,
      agent: d.agent,
      agentType,
      providerID: d.model.providerID,
      modelID: d.model.id,
      ...(promptText ? { promptText } : {}),
    }),
    ...ctx.commonAttrs,
  }
  const active = ctx.tracing.activeLlm.get(d.sessionID)
  const provisional = ctx.tracing.provisionalLlm.get(d.sessionID)
  ctx.tracing.provisionalLlm.delete(d.sessionID)
  const matches = provisional && active?.agent === d.agent && active.modelID === d.model.id && active.providerID === d.model.providerID
  if (provisional && !matches) {
    provisional.setStatus({ code: SpanStatusCode.ERROR, message: "model request did not match step" })
    provisional.end()
  }
  const span = matches ? provisional : ctx.tracer.startSpan(
    llmSpanName(ctx.semconv, d.model.id, ctx.tracePrefix),
    {
      startTime: d.started ?? e.created,
      kind: SpanKind.CLIENT,
      attributes,
    },
    resolveRunContext(d.sessionID, ctx),
  )
  if (matches) span.setAttributes(attributes)
  applyModelContext(d.sessionID, d.agent, d.model, span, ctx)
  setBoundedMap(ctx.tracing.stepSpans, d.assistantMessageID, span)
  setBoundedMap(ctx.tracing.activeStepSpans, d.sessionID, span)
  setBoundedMap(ctx.tracing.stepSpanContexts, d.assistantMessageID, span.spanContext())
  setBoundedMap(ctx.tracing.activeLlm, d.sessionID, {
    agent: d.agent,
    modelID: d.model.id,
    providerID: d.model.providerID,
    spanContext: span.spanContext(),
  })
}

/** Records the first streamed text token for the active LLM step. */
export function handleTextStarted(e: EventOf<"session.text.started">, ctx: HandlerContext) {
  recordFirstToken(e.data.assistantMessageID, e.created, ctx)
}

/** Records the first streamed reasoning token for the active LLM step. */
export function handleReasoningStarted(e: EventOf<"session.reasoning.started">, ctx: HandlerContext) {
  recordFirstToken(e.data.assistantMessageID, e.created, ctx)
}

export function handleTextEnded(e: EventOf<"session.text.ended">, ctx: HandlerContext) {
  const { assistantMessageID, ordinal, text } = e.data
  const output = ctx.tracing.stepOutputs.get(assistantMessageID) ?? new Map<number, string>()
  if (output.size < 32 || output.has(ordinal)) output.set(ordinal, text.slice(0, 64_000))
  setBoundedMap(ctx.tracing.stepOutputs, assistantMessageID, output)
}

function countMessage(messageID: string, sessionID: string, modelID: string, providerID: string, agent: string, ctx: HandlerContext): boolean {
  if (ctx.tracing.countedMessages.has(messageID)) return false
  markSeen(ctx.tracing.countedMessages, messageID)
  if (isMetricEnabled("message.count", ctx)) {
    ctx.instruments.messageCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, agent })
  }
  if (isMetricEnabled("model.usage", ctx)) {
    ctx.instruments.modelUsageCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, provider: providerID, agent })
  }
  return true
}

function outputText(messageID: string, ctx: HandlerContext): string | undefined {
  const output = ctx.tracing.stepOutputs.get(messageID)
  if (!output) return undefined
  return [...output].sort(([a], [b]) => a - b).map(([, text]) => text).join("\n").slice(0, 64_000)
}

/** Records the TTFT histogram and returns the latency in milliseconds for span attributes. */
function recordTtft(
  meta: { startMs: number; firstTokenAt?: number } | undefined,
  sessionID: string,
  modelID: string,
  providerID: string,
  agent: string,
  ctx: HandlerContext,
): number | undefined {
  if (meta?.firstTokenAt === undefined) return undefined
  const ttftMs = Math.max(0, meta.firstTokenAt - meta.startMs)
  // A config hot-reload can reuse an instrument set created before this metric
  // existed. Skip the histogram rather than failing the whole step handler.
  if (ctx.instruments.ttftHistogram && isMetricEnabled("gen_ai.server.time_to_first_token", ctx)) {
    ctx.instruments.ttftHistogram.record(ttftMs / 1000, {
      ...ctx.commonAttrs,
      "session.id": sessionID,
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": genAiProviderName(providerID),
      "gen_ai.request.model": modelID,
      model: modelID,
      agent,
    })
  }
  return ttftMs
}

/** Records token/cost/cache metrics for a completed step and emits an `api_request` log. */
export function handleStepEnded(e: EventOf<"session.step.ended">, ctx: HandlerContext) {
  const d = e.data
  const meta = ctx.tracing.stepMeta.get(d.assistantMessageID)
  const sessionTotals = ctx.tracing.sessionTotals.get(d.sessionID)
  const agent = meta?.agent ?? sessionTotals?.agent ?? "unknown"
  const agentType = meta?.agentType ?? sessionTotals?.agentType ?? "unknown"
  const modelID = meta?.modelID ?? "unknown"
  const providerID = meta?.providerID ?? "unknown"
  const durationMs = Math.max(0, e.created - (meta?.startMs ?? e.created))
  const ttftMs = recordTtft(meta, d.sessionID, modelID, providerID, agent, ctx)

  recordUsageMetrics(d.sessionID, modelID, agent, d.tokens, d.cost, ctx)
  const firstStep = countMessage(d.assistantMessageID, d.sessionID, modelID, providerID, agent, ctx)
  accumulateTotals(d.sessionID, allTokens(d.tokens), d.cost, firstStep, ctx)

  const span = ctx.tracing.stepSpans.get(d.assistantMessageID)
  if (span) {
    const output = outputText(d.assistantMessageID, ctx)
    span.setAttributes(llmEndAttrs(ctx.semconv, {
      agent,
      agentType,
      tokens: d.tokens,
      cost: d.cost,
      finish: d.finish,
      durationMs,
      ttftMs,
      ...(output ? { output } : {}),
    }))
    span.setStatus({ code: SpanStatusCode.OK })
    span.end(e.created)
  }
  cleanupStep(d.assistantMessageID, d.sessionID, ctx)

  ctx.emitLog({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: e.created,
    observedTimestamp: Date.now(),
    body: "api_request",
    attributes: {
      "event.name": "api_request",
      "session.id": d.sessionID,
      model: modelID,
      provider: providerID,
      "gen_ai.provider.name": genAiProviderName(providerID),
      ...agentAttrs(agent, agentType),
      cost_usd: d.cost,
      duration_ms: durationMs,
      input_tokens: d.tokens.input,
      output_tokens: d.tokens.output,
      reasoning_tokens: d.tokens.reasoning,
      cache_read_tokens: d.tokens.cache.read,
      cache_creation_tokens: d.tokens.cache.write,
      ...(ttftMs !== undefined
        ? {
            "gen_ai.server.time_to_first_token": ttftMs / 1000,
            time_to_first_token_ms: ttftMs,
          }
        : {}),
      ...ctx.commonAttrs,
    },
  })
}

/** Records token/cost metrics for a failed step and emits an `api_error` log. */
export function handleStepFailed(e: EventOf<"session.step.failed">, ctx: HandlerContext) {
  const d = e.data
  const meta = ctx.tracing.stepMeta.get(d.assistantMessageID)
  const sessionTotals = ctx.tracing.sessionTotals.get(d.sessionID)
  const agent = meta?.agent ?? sessionTotals?.agent ?? "unknown"
  const agentType = meta?.agentType ?? sessionTotals?.agentType ?? "unknown"
  const modelID = meta?.modelID ?? "unknown"
  const providerID = meta?.providerID ?? "unknown"
  const error = errorSummary(d.error)
  const durationMs = Math.max(0, e.created - (meta?.startMs ?? e.created))
  const ttftMs = recordTtft(meta, d.sessionID, modelID, providerID, agent, ctx)

  recordUsageMetrics(d.sessionID, modelID, agent, d.tokens, d.cost, ctx)
  const firstStep = countMessage(d.assistantMessageID, d.sessionID, modelID, providerID, agent, ctx)
  accumulateTotals(d.sessionID, allTokens(d.tokens), d.cost ?? 0, firstStep, ctx)

  const span = ctx.tracing.stepSpans.get(d.assistantMessageID)
  if (span) {
    const output = outputText(d.assistantMessageID, ctx)
    span.setAttributes(llmFailAttrs(ctx.semconv, {
      agent,
      agentType,
      finish: d.finish,
      durationMs,
      ttftMs,
      ...(d.tokens ? { tokens: d.tokens } : {}),
      ...(d.cost !== undefined ? { cost: d.cost } : {}),
      ...(output ? { output } : {}),
    }))
    span.setStatus({ code: SpanStatusCode.ERROR, message: error })
    span.end(e.created)
  }
  cleanupStep(d.assistantMessageID, d.sessionID, ctx)

  ctx.emitLog({
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
    timestamp: e.created,
    observedTimestamp: Date.now(),
    body: "api_error",
    attributes: {
      "event.name": "api_error",
      "session.id": d.sessionID,
      model: modelID,
      provider: providerID,
      "gen_ai.provider.name": genAiProviderName(providerID),
      ...agentAttrs(agent, agentType),
      error,
      duration_ms: durationMs,
      ...(ttftMs !== undefined
        ? {
            "gen_ai.server.time_to_first_token": ttftMs / 1000,
            time_to_first_token_ms: ttftMs,
          }
        : {}),
      ...ctx.commonAttrs,
    },
  })
}

function recordUsageMetrics(
  sessionID: string,
  modelID: string,
  agent: string,
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } | undefined,
  cost: number | undefined,
  ctx: HandlerContext,
) {
  const base = { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, agent }
  if (tokens && isMetricEnabled("token.usage", ctx)) {
    const { tokenCounter } = ctx.instruments
    tokenCounter.add(tokens.input, { ...base, type: "input" })
    tokenCounter.add(tokens.output, { ...base, type: "output" })
    tokenCounter.add(tokens.reasoning, { ...base, type: "reasoning" })
    tokenCounter.add(tokens.cache.read, { ...base, type: "cacheRead" })
    tokenCounter.add(tokens.cache.write, { ...base, type: "cacheCreation" })
  }
  if (cost !== undefined && isMetricEnabled("cost.usage", ctx)) {
    ctx.instruments.costCounter.add(cost, base)
  }
  if (tokens && isMetricEnabled("cache.count", ctx)) {
    if (tokens.cache.read > 0) ctx.instruments.cacheCounter.add(1, { ...base, type: "cacheRead" })
    if (tokens.cache.write > 0) ctx.instruments.cacheCounter.add(1, { ...base, type: "cacheCreation" })
  }
  void ctx.log("debug", "otel: step usage recorded", {
    sessionID,
    model: modelID,
    agent,
    billed: billedTokens(tokens),
    cost_usd: cost,
  })
}

function cleanupStep(assistantMessageID: string, sessionID: string, ctx: HandlerContext) {
  const spanContext = ctx.tracing.stepSpanContexts.get(assistantMessageID)
  if (spanContext && ctx.tracing.activeStepSpans.get(sessionID)?.spanContext().spanId === spanContext.spanId) {
    ctx.tracing.activeStepSpans.delete(sessionID)
  }
  ctx.tracing.stepSpans.delete(assistantMessageID)
  ctx.tracing.stepSpanContexts.delete(assistantMessageID)
  ctx.tracing.stepMeta.delete(assistantMessageID)
  if (spanContext && ctx.tracing.activeLlm.get(sessionID)?.spanContext.spanId === spanContext.spanId) {
    ctx.tracing.activeLlm.delete(sessionID)
  }
  ctx.tracing.stepOutputs.delete(assistantMessageID)
}
