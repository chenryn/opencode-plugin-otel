import { SeverityNumber } from "@opentelemetry/api-logs"
import { SpanStatusCode } from "@opentelemetry/api"
import type { EventOf, HandlerContext, SessionAgentType, SessionTotals } from "../types.ts"
import { agentEndAttrs, agentOutputAttrs, agentSpanName, agentStartAttrs, errorAttrs, OPENCODE_ATTR, retryAttrs, signalAttrs } from "../semconv.ts"
import { hashJson, sha256Hex } from "../facts.ts"
import {
  errorSummary,
  isMetricEnabled,
  isTraceEnabled,
  markSeen,
  modelRef,
  nextTurnID,
  normalizeNames,
  resolveSubagentTraceContext,
  sessionSpanContext,
  setBoundedMap,
  subagentDispatchCallID,
  totalTokens,
  truncateContent,
  truncationAttrs,
} from "../util.ts"

/** Maximum number of skill names retained per prompt. */
const MAX_PROMPT_SKILLS = 20
/** Maximum characters retained per skill name. */
const MAX_SKILL_NAME = 128

export function handlePromptEnqueued(e: EventOf<"session.inbox.enqueued">, ctx: HandlerContext, capturePrompt: boolean) {
  const { sessionID, inboxID, item } = e.data
  if (item.type !== "user") return
  const parts = [item.payload.text]
  for (const file of item.payload.files ?? []) parts.push(file.name ?? (file.source.type === "uri" ? file.source.uri : ""))
  for (const agent of item.payload.agents ?? []) parts.push(agent.name)
  for (const skill of item.payload.skills ?? []) parts.push(skill.name)
  const text = parts.filter(Boolean).join("\n")
  const skills = normalizeNames(item.payload.skills?.map((skill) => skill.name), MAX_PROMPT_SKILLS, MAX_SKILL_NAME)
  if (item.delivery === "steer" && ctx.tracing.activeExecutions.has(sessionID)) {
    const active = ctx.tracing.activePrompts.get(sessionID)
    const merged = active?.text ? `${active.text}\n${text}` : text
    setBoundedMap(ctx.tracing.activePrompts, sessionID, {
      text: merged,
      startMs: active?.startMs ?? e.created,
      ...(merged ? { hash: sha256Hex(merged) } : {}),
      ...mergeSkills(active?.skills, skills),
    })
  } else {
    const queue = ctx.tracing.pendingPrompts.get(sessionID) ?? []
    if (queue.length < 100) queue.push({ text, startMs: e.created, ...(text ? { hash: sha256Hex(text) } : {}), ...(skills.length ? { skills } : {}) })
    setBoundedMap(ctx.tracing.pendingPrompts, sessionID, queue)
  }
  const totals = ctx.tracing.sessionTotals.get(sessionID)
  const prompt = truncateContent(text)
  ctx.emitEvent({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: e.created,
    observedTimestamp: Date.now(),
    body: "user_prompt",
    attributes: {
      "event.name": "user_prompt",
      ...signalAttrs(ctx.semconv, {
        sessionID,
        ...(totals ? { agent: totals.agent, agentType: totals.agentType, agentVersion: totals.agentVersion } : {}),
      }),
      "message.id": inboxID,
      prompt_length: text.length,
      ...(text ? { [OPENCODE_ATTR.promptHash]: sha256Hex(text) } : {}),
      ...(capturePrompt && ctx.captureContent
        ? { prompt: prompt.text, ...truncationAttrs("prompt", prompt) }
        : {}),
      ...(skills.length ? { "skill.name": skills } : {}),
      delivery: item.delivery,
      ...ctx.commonAttrs,
    },
  }, sessionSpanContext(sessionID, ctx))
}

/** Merges skill name lists into a deduplicated, bounded list, or reports none. */
function mergeSkills(current: readonly string[] | undefined, next: readonly string[]): { skills?: string[] } {
  const merged = normalizeNames([...(current ?? []), ...next], MAX_PROMPT_SKILLS, MAX_SKILL_NAME)
  return merged.length ? { skills: merged } : {}
}

function countSession(sessionID: string, isSubagent: boolean, ctx: HandlerContext) {
  if (ctx.tracing.countedSessions.has(sessionID)) return
  markSeen(ctx.tracing.countedSessions, sessionID)
  if (isMetricEnabled("session.count", ctx)) {
    ctx.instruments.sessionCounter.add(1, {
      ...ctx.commonAttrs,
      ...signalAttrs(ctx.semconv, { sessionID }),
      is_subagent: isSubagent,
    })
  }
}

/**
 * Ensures session totals exist for a session id. OpenCode does not replay durable
 * events, so a session created before the plugin subscribed (for example a
 * pre-existing session resumed with `opencode run`) never emits `session.created`;
 * the first event we observe for it initializes and counts the session lazily.
 */
export function ensureSession(sessionID: string, at: number, ctx: HandlerContext): SessionTotals {
  const existing = ctx.tracing.sessionTotals.get(sessionID)
  if (existing) return existing
  const identity = ctx.tracing.sessionIdentity.get(sessionID)
  countSession(sessionID, identity?.agentType === "subagent", ctx)
  const totals: SessionTotals = {
    startMs: identity?.startMs ?? at,
    tokens: identity?.tokens ?? 0,
    cost: identity?.cost ?? 0,
    messages: identity?.messages ?? 0,
    agent: identity?.agent ?? "unknown",
    agentType: identity?.agentType ?? "primary",
    agentVersion: identity?.agentVersion ?? ctx.agentVersion,
    ...(identity?.parentID ? { parentID: identity.parentID } : {}),
  }
  setBoundedMap(ctx.tracing.sessionTotals, sessionID, totals)
  return totals
}

/** Increments the session counter, records totals, and emits a `session.created` log event. */
export function handleSessionCreated(e: EventOf<"session.created">, ctx: HandlerContext) {
  const d = e.data
  const isSubagent = !!d.parentID
  const agentType: SessionAgentType = isSubagent ? "subagent" : "primary"
  const agent = d.agent ?? "unknown"

  setBoundedMap(ctx.tracing.sessionProjects, d.sessionID, d.projectID)
  setBoundedMap(ctx.tracing.sessionIdentity, d.sessionID, {
    agent,
    agentType,
    agentVersion: ctx.agentVersion,
    ...(d.parentID ? { parentID: d.parentID } : {}),
    startMs: e.created,
  })
  countSession(d.sessionID, isSubagent, ctx)
  if (isSubagent && isMetricEnabled("subtask.count", ctx)) {
    ctx.instruments.subtaskCounter.add(1, {
      ...ctx.commonAttrs,
      ...signalAttrs(ctx.semconv, { sessionID: d.sessionID, agent, agentType: "subagent", agentVersion: ctx.agentVersion }),
    })
  }
  if (isSubagent) {
    ctx.emitEvent({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      timestamp: e.created,
      observedTimestamp: Date.now(),
      body: "subtask_invoked",
      attributes: {
        "event.name": "subtask_invoked",
        ...signalAttrs(ctx.semconv, { sessionID: d.sessionID, agent, agentType, agentVersion: ctx.agentVersion }),
        "parent.session.id": d.parentID,
        ...ctx.commonAttrs,
      },
    }, sessionSpanContext(d.sessionID, ctx))
  }

  setBoundedMap(ctx.tracing.sessionTotals, d.sessionID, {
    startMs: e.created,
    tokens: ctx.tracing.sessionTotals.get(d.sessionID)?.tokens ?? 0,
    cost: ctx.tracing.sessionTotals.get(d.sessionID)?.cost ?? 0,
    messages: ctx.tracing.sessionTotals.get(d.sessionID)?.messages ?? 0,
    agent,
    agentType,
    agentVersion: ctx.agentVersion,
    ...(d.parentID ? { parentID: d.parentID } : {}),
  })

  ctx.emitEvent({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: e.created,
    observedTimestamp: Date.now(),
    body: "session.created",
    attributes: {
      "event.name": "session.created",
      ...signalAttrs(ctx.semconv, { sessionID: d.sessionID, agent, agentType, agentVersion: ctx.agentVersion }),
      is_subagent: isSubagent,
      ...(d.model ? { model: modelRef(d.model) } : {}),
      ...ctx.commonAttrs,
    },
  }, sessionSpanContext(d.sessionID, ctx))
  void ctx.log("info", "otel: session.created", { sessionID: d.sessionID, isSubagent })
}

export function handleAgentSelected(e: EventOf<"session.agent.selected">, ctx: HandlerContext) {
  const { sessionID, agent } = e.data
  const identity = ctx.tracing.sessionIdentity.get(sessionID)
  if (identity) setBoundedMap(ctx.tracing.sessionIdentity, sessionID, { ...identity, agent, agentVersion: ctx.agentVersion })
  const totals = ctx.tracing.sessionTotals.get(sessionID)
  if (totals) setBoundedMap(ctx.tracing.sessionTotals, sessionID, { ...totals, agent, agentVersion: ctx.agentVersion })
}

/** Starts the root run span for a single execution (user turn), keyed by session id. */
export function handleExecutionStarted(e: EventOf<"session.execution.started">, ctx: HandlerContext) {
  const sessionID = e.data.sessionID
  markSeen(ctx.tracing.activeExecutions, sessionID)
  ctx.tracing.turnOutputs.delete(sessionID)
  const totals = ensureSession(sessionID, e.created, ctx)
  // Allocate the turn before the trace check so a later-enabled step/tool trace still
  // inherits a stable turn id, even when run spans are disabled.
  const turnID = nextTurnID(sessionID, ctx)
  ctx.tracing.sessionRetries.delete(sessionID)
  const queue = ctx.tracing.pendingPrompts.get(sessionID)
  const pendingPrompt = queue?.shift()
  if (queue?.length === 0) ctx.tracing.pendingPrompts.delete(sessionID)
  if (pendingPrompt) setBoundedMap(ctx.tracing.activePrompts, sessionID, pendingPrompt)

  if (!isTraceEnabled("session", ctx)) return

  const isSubagent = totals?.agentType === "subagent"
  const parentSessionID = isSubagent ? totals?.parentID : undefined
  const parentToolCallID = isSubagent ? subagentDispatchCallID(sessionID, ctx) : undefined
  const parentCtx = isSubagent && parentSessionID
    ? resolveSubagentTraceContext(sessionID, parentSessionID, totals.agent, ctx)
    : ctx.rootContext()
  const promptText = ctx.captureContent ? pendingPrompt?.text ?? "" : ""

  const span = ctx.tracer.startSpan(
    agentSpanName(ctx.semconv, totals?.agent ?? "unknown", ctx.tracePrefix),
    {
      startTime: e.created,
      attributes: {
        ...agentStartAttrs(ctx.semconv, {
          sessionID,
          agent: totals?.agent ?? "unknown",
          agentType: totals?.agentType ?? "primary",
          agentVersion: totals?.agentVersion,
          isSubagent,
          turnID,
          ...(parentSessionID ? { parentSessionID } : {}),
          ...(parentToolCallID ? { parentToolCallID } : {}),
          ...(pendingPrompt?.skills?.length ? { skillNames: pendingPrompt.skills } : {}),
          ...(pendingPrompt?.hash ? { promptHash: pendingPrompt.hash } : {}),
          ...(ctx.tracing.sessionToolsets.get(sessionID)?.hash
            ? { toolsetHash: ctx.tracing.sessionToolsets.get(sessionID)!.hash }
            : {}),
          ...(promptText ? { promptText } : {}),
        }),
        ...ctx.commonAttrs,
      },
    },
    parentCtx,
  )
  setBoundedMap(ctx.tracing.runSpans, sessionID, span)
  setBoundedMap(ctx.tracing.runSpanContexts, sessionID, span.spanContext())
  ctx.traceStore?.saveRun(sessionID, span.spanContext())
}

/** Terminal execution events that end the root run span. */
export type ExecutionOutcome =
  | { type: "succeeded" }
  | { type: "failed"; error: { type: string; message: string; status?: number } }
  | { type: "interrupted"; reason: string }

/**
 * Ends the root run span for an execution with the given outcome and emits a
 * `session.error` log event when the execution failed.
 */
export function handleExecutionEnded(
  e: EventOf<"session.execution.succeeded"> | EventOf<"session.execution.failed"> | EventOf<"session.execution.interrupted">,
  ctx: HandlerContext,
  outcome: ExecutionOutcome,
) {
  const sessionID = e.data.sessionID
  const totals = ctx.tracing.sessionTotals.get(sessionID)
  ctx.tracing.activeExecutions.delete(sessionID)
  const pendingDispatch = ctx.tracing.subagentParents.get(sessionID)
  if (pendingDispatch) {
    ctx.tracing.subagentParents.delete(sessionID)
    markSeen(ctx.tracing.consumedSubagentDispatches, pendingDispatch.callID)
  }

  sweepExecution(sessionID, ctx)

  const span = ctx.tracing.runSpans.get(sessionID)
  if (span) {
    if (totals) {
      const toolset = ctx.tracing.sessionToolsets.get(sessionID)
      const models = [...(ctx.tracing.sessionModels.get(sessionID) ?? [])].sort()
      const configHash = hashJson({
        agent: totals.agent,
        version: totals.agentVersion ?? "",
        toolset: toolset?.hash ?? "",
        models,
      })
      span.setAttributes(agentEndAttrs(ctx.semconv, {
        ...totals,
        configHash,
        ...(toolset?.hash ? { toolsetHash: toolset.hash } : {}),
      }))
      const output = ctx.captureContent ? ctx.tracing.turnOutputs.get(sessionID) : undefined
      if (output) span.setAttributes(agentOutputAttrs(ctx.semconv, output))
      // The agent can only be resolved once a step or session lookup lands, which may be
      // after the run span started. Rename so a gen_ai span is not stuck at "invoke_agent unknown".
      span.updateName(agentSpanName(ctx.semconv, totals.agent, ctx.tracePrefix))
    }
    if (outcome.type === "failed") {
      const message = errorSummary(outcome.error)
      span.setAttributes(errorAttrs(outcome.error))
      span.setStatus({ code: SpanStatusCode.ERROR, message })
      span.setAttribute("error", message)
    } else if (outcome.type === "interrupted") {
      span.setAttribute("session.interrupted_reason", outcome.reason)
      span.setStatus({ code: SpanStatusCode.OK })
    } else {
      span.setStatus({ code: SpanStatusCode.OK })
    }
    span.end(e.created)
    ctx.tracing.runSpans.delete(sessionID)
  }
  ctx.tracing.turnOutputs.delete(sessionID)
  void ctx.traceStore?.clear(sessionID)

  if (outcome.type === "failed") {
    const message = errorSummary(outcome.error)
    ctx.emitEvent({
      severityNumber: SeverityNumber.ERROR,
      severityText: "ERROR",
      timestamp: e.created,
      observedTimestamp: Date.now(),
      body: "session.error",
      attributes: {
        "event.name": "session.error",
        ...signalAttrs(ctx.semconv, {
          sessionID,
          agent: totals?.agent ?? "unknown",
          agentType: totals?.agentType ?? "unknown",
          agentVersion: totals?.agentVersion,
        }),
        error: message,
        ...errorAttrs(outcome.error),
        ...ctx.commonAttrs,
      },
    }, sessionSpanContext(sessionID, ctx))
    void ctx.log("error", "otel: session.error", { sessionID, error: message })
  }
}

/** Handles `session.status` idle and retry diagnostics. */
export function handleSessionStatus(e: EventOf<"session.status">, ctx: HandlerContext) {
  const { sessionID, status } = e.data
  if (status.type === "retry") {
    void ctx.log("debug", "otel: retry scheduled", { sessionID, attempt: status.attempt })
    return
  }
  if (status.type === "idle") finalizeSession(sessionID, ctx)
}

/**
 * Records a scheduled API retry on the retry counter and, when the run span exists, on the
 * span itself. The event is durable and emitted once per attempt, so the counter never adds
 * a retry to a normal call.
 */
export function handleRetryScheduled(e: EventOf<"session.retry.scheduled">, ctx: HandlerContext) {
  const { sessionID, attempt, error } = e.data
  const count = (ctx.tracing.sessionRetries.get(sessionID) ?? 0) + 1
  setBoundedMap(ctx.tracing.sessionRetries, sessionID, count)
  if (isMetricEnabled("retry.count", ctx)) {
    const totals = ctx.tracing.sessionTotals.get(sessionID)
    ctx.instruments.retryCounter.add(1, {
      ...ctx.commonAttrs,
      ...signalAttrs(ctx.semconv, {
        sessionID,
        ...(totals ? { agent: totals.agent, agentType: totals.agentType, agentVersion: totals.agentVersion } : {}),
      }),
      ...retryAttrs({ attempt, error }),
    })
  }
  // A retry can be scheduled before the run span exists (or with run spans disabled).
  ctx.tracing.runSpans.get(sessionID)?.setAttributes(retryAttrs({ attempt, count, error }))
}

/** Handles the deprecated `session.idle` event as an idle finalization signal. */
export function handleSessionIdle(e: EventOf<"session.idle">, ctx: HandlerContext) {
  finalizeSession(e.data.sessionID, ctx)
}

/**
 * Updates the running session totals from the authoritative cumulative usage
 * sample emitted by opencode after each step.
 */
export function handleUsageUpdated(e: EventOf<"session.usage.updated">, ctx: HandlerContext) {
  const { sessionID, cost, tokens } = e.data
  const existing = ensureSession(sessionID, e.created, ctx)
  const next: SessionTotals = {
    ...existing,
    tokens: totalTokens(tokens) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0),
    cost,
  }
  setBoundedMap(ctx.tracing.sessionTotals, sessionID, next)
}

/**
 * Records session duration and total token/cost histograms and emits a
 * `session.idle` log, then clears per-session state. No-ops when the session
 * totals were already finalized, so a status-idle followed by a deprecated
 * idle event does not double count.
 */
export function finalizeSession(sessionID: string, ctx: HandlerContext) {
  const spanContext = sessionSpanContext(sessionID, ctx)
  const totals = ctx.tracing.sessionTotals.get(sessionID)
  if (!totals) {
    ctx.tracing.runSpanContexts.delete(sessionID)
    sweepExecution(sessionID, ctx)
    return
  }
  const identity = ctx.tracing.sessionIdentity.get(sessionID)
  if (identity) {
    setBoundedMap(ctx.tracing.sessionIdentity, sessionID, {
      ...identity,
      agent: totals.agent,
      agentType: totals.agentType,
      tokens: totals.tokens,
      cost: totals.cost,
      messages: totals.messages,
    })
  }
  ctx.tracing.sessionTotals.delete(sessionID)
  ctx.tracing.runSpanContexts.delete(sessionID)
  ctx.tracing.restoredRunContexts.delete(sessionID)
  ctx.tracing.turnOutputs.delete(sessionID)
  ctx.tracing.activeLlm.delete(sessionID)
  ctx.tracing.activeStepSpans.delete(sessionID)
  ctx.tracing.modelContexts.delete(sessionID)
  ctx.tracing.activePrompts.delete(sessionID)
  ctx.tracing.activeExecutions.delete(sessionID)
  ctx.tracing.sessionRetries.delete(sessionID)
  void ctx.traceStore?.clear(sessionID)

  const attrs = {
    ...ctx.commonAttrs,
    ...signalAttrs(ctx.semconv, {
      sessionID,
      agent: totals.agent,
      agentType: totals.agentType,
      agentVersion: totals.agentVersion,
    }),
  }
  const durationMs = Date.now() - totals.startMs
  if (isMetricEnabled("session.duration", ctx)) {
    ctx.instruments.sessionDurationHistogram.record(durationMs, attrs)
  }
  if (isMetricEnabled("session.token.total", ctx)) {
    ctx.instruments.sessionTokenHistogram.record(totals.tokens, attrs)
  }
  if (isMetricEnabled("session.cost.total", ctx)) {
    ctx.instruments.sessionCostHistogram.record(totals.cost, attrs)
  }

  ctx.emitEvent({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: Date.now(),
    observedTimestamp: Date.now(),
    body: "session.idle",
    attributes: {
      "event.name": "session.idle",
      ...signalAttrs(ctx.semconv, {
        sessionID,
        agent: totals.agent,
        agentType: totals.agentType,
        agentVersion: totals.agentVersion,
      }),
      total_tokens: totals.tokens,
      total_cost_usd: totals.cost,
      total_messages: totals.messages,
      ...ctx.commonAttrs,
    },
  }, spanContext)
  void ctx.log("debug", "otel: session.idle", {
    sessionID,
    duration_ms: durationMs,
    total_tokens: totals.tokens,
    total_cost_usd: totals.cost,
    total_messages: totals.messages,
  })
}

/** Ends and clears any dangling step/tool spans for a session execution. */
function sweepExecution(sessionID: string, ctx: HandlerContext) {
  const provisional = ctx.tracing.provisionalLlm.get(sessionID)
  if (provisional) {
    provisional.setStatus({ code: SpanStatusCode.ERROR, message: "execution ended before step started" })
    provisional.end()
    ctx.tracing.provisionalLlm.delete(sessionID)
    ctx.tracing.activeLlm.delete(sessionID)
  }
  for (const [callID, span] of ctx.tracing.toolSpans) {
    if (ctx.tracing.toolMeta.get(callID)?.sessionID !== sessionID) continue
    span.setStatus({ code: SpanStatusCode.ERROR, message: "session execution ended before tool completed" })
    span.end()
    ctx.tracing.toolSpans.delete(callID)
    ctx.tracing.toolSpanContexts.delete(callID)
    ctx.tracing.toolMeta.delete(callID)
  }
  for (const [messageID, meta] of ctx.tracing.stepMeta) {
    if (meta.sessionID !== sessionID) continue
    const span = ctx.tracing.stepSpans.get(messageID)
    if (span) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "session execution ended before step completed" })
      span.end()
    }
    ctx.tracing.stepSpans.delete(messageID)
    ctx.tracing.stepSpanContexts.delete(messageID)
    ctx.tracing.restoredStepContexts.delete(messageID)
    ctx.tracing.stepMeta.delete(messageID)
    ctx.tracing.stepOutputs.delete(messageID)
    ctx.tracing.stepReasoning.delete(messageID)
  }
  for (const [messageID, restored] of ctx.tracing.restoredStepContexts) {
    if (restored.sessionID === sessionID) ctx.tracing.restoredStepContexts.delete(messageID)
  }
  for (const [id, perm] of ctx.tracing.pendingPermissions) {
    if (perm.sessionID === sessionID) ctx.tracing.pendingPermissions.delete(id)
  }
}

/**
 * Clears every per-session correlation map when opencode deletes a session. Without this the
 * state would only leave memory when the bounded maps evict it, and a reused id could inherit
 * another session's spans.
 */
export async function handleSessionDeleted(e: EventOf<"session.deleted">, ctx: HandlerContext) {
  const sessionID = e.data.sessionID
  ctx.tracing.activeExecutions.delete(sessionID)
  sweepExecution(sessionID, ctx)
  const span = ctx.tracing.runSpans.get(sessionID)
  if (span) {
    span.setAttribute("session.deleted", true)
    span.end(e.created)
    ctx.tracing.runSpans.delete(sessionID)
  }
  ctx.tracing.runSpanContexts.delete(sessionID)
  ctx.tracing.restoredRunContexts.delete(sessionID)
  ctx.tracing.restorePromises.delete(sessionID)
  ctx.tracing.sessionTotals.delete(sessionID)
  ctx.tracing.sessionIdentity.delete(sessionID)
  ctx.tracing.sessionProjects.delete(sessionID)
  ctx.tracing.sessionToolsets.delete(sessionID)
  ctx.tracing.sessionModels.delete(sessionID)
  ctx.tracing.sessionTurns.delete(sessionID)
  ctx.tracing.sessionRetries.delete(sessionID)
  ctx.tracing.pendingPrompts.delete(sessionID)
  ctx.tracing.activePrompts.delete(sessionID)
  ctx.tracing.modelContexts.delete(sessionID)
  ctx.tracing.turnOutputs.delete(sessionID)
  ctx.tracing.activeLlm.delete(sessionID)
  ctx.tracing.provisionalLlm.delete(sessionID)
  ctx.tracing.activeStepSpans.delete(sessionID)
  ctx.tracing.subagentParents.delete(sessionID)
  for (const [callID, meta] of ctx.tracing.toolMeta) {
    if (meta.sessionID === sessionID) ctx.tracing.toolMeta.delete(callID)
  }
  await ctx.traceStore?.clear(sessionID)
}

/**
 * Ends spans left open by an in-flight execution when the last plugin instance in the process
 * unloads. The persisted trace context stays, so the replacement instance keeps the same trace.
 */
export function finalizeOnShutdown(ctx: HandlerContext) {
  for (const [sessionID, span] of [...ctx.tracing.runSpans]) {
    sweepExecution(sessionID, ctx)
    span.setAttribute("session.interrupted_reason", "plugin stopped")
    span.setStatus({ code: SpanStatusCode.OK })
    span.end()
    ctx.tracing.runSpans.delete(sessionID)
  }
  ctx.tracing.provisionalLlm.clear()
  ctx.tracing.turnOutputs.clear()
}
