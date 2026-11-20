import { ROOT_CONTEXT, isSpanContextValid } from "@opentelemetry/api"
import pkg from "../package.json" with { type: "json" }
import { loadConfig, parseAttributePairs, resolveHelperPath, resolveLogLevel, type OtelPluginOptions } from "./config.ts"
import { isEventSuppressed } from "./semconv.ts"
import { probeEndpoint } from "./probe.ts"
import { buildResource, forceFlushOtel } from "./otel.ts"
import { remoteParentContext } from "./trace-context.ts"
import { acquireSharedOtel, acquireTracingState, createFlushScheduler, flushSharedOtel, releaseSharedOtel } from "./state.ts"
import { drainExportHealth, recordDispatchError, recordFlush } from "./export-health.ts"
import { createLocalEventLog, toEpochMillis } from "./local-event-log.ts"
import { createTraceStore } from "./trace-store.ts"
import { LEVELS, type HandlerContext, type Level, type OpenCodeContext, type OpenCodeEvent } from "./types.ts"
import { consumeEvents, contextForSession, eventContext, restoreSessionTraceContext, setBoundedMap } from "./util.ts"
import {
  finalizeOnShutdown,
  finalizeSession,
  handleExecutionEnded,
  handleExecutionStarted,
  handleAgentSelected,
  handlePromptEnqueued,
  handleSessionCreated,
  handleSessionDeleted,
  handleSessionIdle,
  handleRetryScheduled,
  handleSessionStatus,
  handleUsageUpdated,
} from "./handlers/session.ts"
import {
  handleReasoningEnded,
  handleReasoningStarted,
  handleStepEnded,
  handleStepFailed,
  handleStepStarted,
  handleTextEnded,
  handleTextStarted,
} from "./handlers/step.ts"
import { handleCompactionEnded, handleCompactionFailed, handleCompactionStarted } from "./handlers/compaction.ts"
import { handleToolCalled, handleToolFailed, handleToolInputStarted, handleToolProgress, handleToolSuccess } from "./handlers/tool.ts"
import { handlePermissionAsked, handlePermissionReplied } from "./handlers/permission.ts"
import { captureModelContext, captureToolset, handleModelRequest } from "./handlers/chat-headers.ts"
import { setupGuard, type GuardTelemetry } from "./guard/guard.ts"
import { handlePromptDefense, type PromptDefenseOptions } from "./guard/prompt-defense-hook.ts"

const PLUGIN_VERSION: string = (pkg as { version?: string }).version ?? "unknown"
const EXIT_HOOK_KEY = "__opencode_plugin_otel_exit_hook__"

/**
 * OpenCode V2 plugin entrypoint. Sets up the OTel SDK, subscribes to the granular
 * V2 event stream (`session.*`), and emits spans, metrics, and log events mirroring
 * the Claude Code monitoring signals. All instrumentation is gated on
 * `OPENCODE_ENABLE_TELEMETRY` (or the `enabled` plugin option).
 */
export async function setup(ctx: OpenCodeContext): Promise<() => Promise<void>> {
  const config = loadConfig(ctx.options as OtelPluginOptions)
  const minLevel: Level = resolveLogLevel(config.logLevel ?? "info", "info")

  const log: HandlerContext["log"] = async (level, message, extra) => {
    if (LEVELS[level] < LEVELS[minLevel]) return
    const line = `[opencode-plugin-otel] ${message}`
    if (level === "error") console.error(line, extra ?? "")
    else if (level === "warn") console.warn(line, extra ?? "")
    else console.log(line, extra ?? "")
  }

  if (!config.enabled && !config.guard.guardEnabled) {
    await log("info", "telemetry disabled (set OPENCODE_ENABLE_TELEMETRY or the enabled option to enable)")
    return async () => {}
  }

  if (!config.enabled) {
    // guard-only mode: the runtime guard runs without the OTel SDK; decisions are
    // enforced and logged to the server console but not exported.
    const guardTeardownOnly = await setupGuard(ctx, config.guard, null, log)
    return async () => {
      await guardTeardownOnly()
    }
  }

  config.otlpHeadersHelper = resolveHelperPath(
    config.otlpHeadersHelper,
    ctx.location.directory,
    ctx.location.project.directory,
  )

  await log("info", "starting up", {
    version: PLUGIN_VERSION,
    endpoint: config.endpoint,
    protocol: config.protocol,
    metricsInterval: config.metricsInterval,
    logsInterval: config.logsInterval,
    metricPrefix: config.metricPrefix,
    semconv: config.semconv,
    captureModelContext: config.captureModelContext,
    captureContextSnapshot: config.captureContextSnapshot,
    agentVersion: config.agentVersion ?? ctx.app.version,
    emitRedundantEvents: config.emitRedundantEvents,
    headersHelperSet: !!config.otlpHeadersHelper,
  })

  const probe = await probeEndpoint(config.endpoint)
  if (probe.ok) {
    await log("info", "OTLP endpoint reachable", { endpoint: config.endpoint, ms: probe.ms })
  } else {
    await log("warn", "OTLP endpoint unreachable — exports may fail", { endpoint: config.endpoint, error: probe.error })
  }

  const shared = await acquireSharedOtel(config, PLUGIN_VERSION)
  const tracing = acquireTracingState()
  const traceStore = createTraceStore(ctx.storage, (error) => {
    void log("warn", "trace context persistence failed", { error: error instanceof Error ? error.message : String(error) })
  })
  const commonAttrs = parseAttributePairs(config.spanAttributes)
  const flush = createFlushScheduler(async () => {
    const outcome = await forceFlushOtel(shared.providers)
    recordFlush(shared.providers.health, outcome.ok, outcome.durationMs)
    drainExportHealth(shared.providers.health, shared.instruments, config.disabledMetrics, commonAttrs)
  })
  await log("info", "OTel SDK initialized")

  const g = globalThis as Record<string, unknown>
  if (!g[EXIT_HOOK_KEY]) {
    g[EXIT_HOOK_KEY] = true
    process.once("beforeExit", () => {
      void flushSharedOtel()
    })
  }

  const localEventLog = config.localEventLog ? createLocalEventLog(config.localEventLogPath) : null
  if (localEventLog) await log("info", "local log event mirror enabled", { path: config.localEventLogPath })
  const localEventResource = buildResource(PLUGIN_VERSION, config.resourceAttributes ?? "").attributes

  const emitEvent: HandlerContext["emitEvent"] = (record, spanContext) => {
    if (!config.logsEnabled) return
    if (!config.emitRedundantEvents && isEventSuppressed(config.semconv, String(record.body))) return
    const context = eventContext(spanContext)
    if (localEventLog) {
      const observed = toEpochMillis(record.observedTimestamp)
      localEventLog.append({
        time: new Date(toEpochMillis(record.timestamp) ?? Date.now()).toISOString(),
        ...(observed === undefined ? {} : { observedTime: new Date(observed).toISOString() }),
        ...(record.severityNumber === undefined ? {} : { severityNumber: record.severityNumber }),
        ...(record.severityText ? { severityText: record.severityText } : {}),
        body: String(record.body),
        ...(spanContext && isSpanContextValid(spanContext)
          ? { traceId: spanContext.traceId, spanId: spanContext.spanId }
          : {}),
        attributes: record.attributes ?? {},
        resource: localEventResource,
      })
    }
    shared.logger.emit(context ? { ...record, context } : record)
  }

  const remoteContext = remoteParentContext(config.traceparent, config.tracestate)
  if (config.traceparent && !remoteContext) {
    await log("warn", "invalid OPENCODE_TRACEPARENT ignored", { traceparentLength: config.traceparent.length })
  }

  const hctx: HandlerContext = {
    log,
    emitEvent,
    instruments: shared.instruments,
    commonAttrs,
    disabledMetrics: config.disabledMetrics,
    disabledTraces: config.disabledTraces,
    semconv: config.semconv,
    agentVersion: config.agentVersion ?? ctx.app.version,
    captureContent: config.semconv === "gen_ai" ? config.captureModelContext : true,
    captureToolFacts: config.captureToolFacts,
    captureContextSnapshot: config.captureContextSnapshot,
    tracer: shared.tracer,
    tracePrefix: config.metricPrefix,
    rootContext: remoteContext ? () => remoteContext : () => ROOT_CONTEXT,
    tracing,
    tracePropagationProviders: config.tracePropagationProviders,
    traceStore,
  }

  if (config.disabledMetrics.size > 0) await log("info", "metrics disabled", { disabled: [...config.disabledMetrics] })
  if (config.disabledTraces.size > 0) await log("info", "traces disabled", { disabled: [...config.disabledTraces] })
  if (!config.logsEnabled) await log("info", "OTLP log events disabled")
  if (!config.emitRedundantEvents) {
    await log("info", "log events that duplicate a span are suppressed", { semconv: config.semconv })
  }
  if (config.capturePromptInLogs) {
    await log("info", "prompt-in-logs capture enabled - full prompt text emitted in the `prompt` attribute of user_prompt log events")
  }
  if (config.captureContextSnapshot) {
    await log("info", "full context snapshot capture enabled - system prompt, messages, and tool schemas are attached to LLM spans")
  }

  let guardTeardown: (() => Promise<void>) | null = null
  if (config.guard.guardEnabled) {
    const guardTelemetry: GuardTelemetry = { hctx }
    guardTeardown = await setupGuard(ctx, config.guard, guardTelemetry, log)
  }

  const scoped = (sessionID: string) => contextForSession(
    sessionID,
    hctx,
    async (id) => ctx.session.get({ sessionID: id }),
  )

  // A single context hook serves toolset fingerprinting, model-context capture, and
  // prompt defense; registering it twice would double the callbacks on the same event.
  {
    const promptDefenseOptions: PromptDefenseOptions = {
      minGrade: config.guard.guardPromptDefenseMinGrade,
      injectContext: config.guard.guardPromptDefenseInjectContext,
      failMode: config.guard.guardFailMode ?? "fail_open",
    }
    await ctx.session.hook("context", async (event) => {
      captureToolset(event, hctx)
      if (config.captureModelContext || config.captureContextSnapshot) {
        captureModelContext(event, await scoped(event.sessionID))
      }
      if (config.guard.guardPromptDefense) {
        await handlePromptDefense(event as never, hctx, promptDefenseOptions, log)
      }
    })
  }

  await ctx.session.hook("model.request", async (event) => {
    await handleModelRequest(event, await scoped(event.sessionID))
  })

  if (config.tracePropagationProviders.size > 0) {
    try {
      await ctx.session.hook("experimental.ws.handshake", async (event) => {
        await handleModelRequest(event, await scoped(event.sessionID))
      })
    } catch {
      await log("warn", "WebSocket trace propagation hook unavailable", { version: ctx.app.version })
    }
  }

  const dispatch = async (event: OpenCodeEvent): Promise<void> => {
    if (event.type === "session.created") {
      setBoundedMap(tracing.sessionProjects, event.data.sessionID, event.data.projectID)
      setBoundedMap(tracing.sessionIdentity, event.data.sessionID, {
        agent: event.data.agent ?? "unknown",
        agentType: event.data.parentID ? "subagent" : "primary",
        ...(event.data.parentID ? { parentID: event.data.parentID } : {}),
        startMs: event.created,
      })
    }
    const sessionID = "sessionID" in event.data && typeof event.data.sessionID === "string"
      ? event.data.sessionID
      : undefined
    if (sessionID) await restoreSessionTraceContext(sessionID, hctx)
    const eventCtx = sessionID ? await scoped(sessionID) : hctx
    switch (event.type) {
      case "session.created":
        handleSessionCreated(event, eventCtx)
        break
      case "session.deleted":
        await handleSessionDeleted(event, eventCtx)
        break
      case "session.agent.selected":
        handleAgentSelected(event, eventCtx)
        break
      case "session.inbox.enqueued":
        handlePromptEnqueued(event, eventCtx, config.capturePromptInLogs)
        break
      case "session.execution.started":
        handleExecutionStarted(event, eventCtx)
        break
      case "session.execution.succeeded":
        handleExecutionEnded(event, eventCtx, { type: "succeeded" })
        finalizeSession(event.data.sessionID, eventCtx)
        flush.request()
        break
      case "session.execution.failed":
        handleExecutionEnded(event, eventCtx, { type: "failed", error: event.data.error })
        finalizeSession(event.data.sessionID, eventCtx)
        flush.request()
        break
      case "session.execution.interrupted":
        handleExecutionEnded(event, eventCtx, { type: "interrupted", reason: event.data.reason })
        finalizeSession(event.data.sessionID, eventCtx)
        flush.request()
        break
      case "session.status":
        handleSessionStatus(event, eventCtx)
        break
      case "session.idle":
        handleSessionIdle(event, eventCtx)
        flush.request()
        break
      case "session.usage.updated":
        handleUsageUpdated(event, eventCtx)
        break
      case "session.retry.scheduled":
        handleRetryScheduled(event, eventCtx)
        break
      case "session.step.started":
        handleStepStarted(event, eventCtx)
        break
      case "session.text.started":
        handleTextStarted(event, eventCtx)
        break
      case "session.reasoning.started":
        handleReasoningStarted(event, eventCtx)
        break
      case "session.reasoning.ended":
        handleReasoningEnded(event, eventCtx)
        break
      case "session.compaction.started":
        handleCompactionStarted(event, eventCtx)
        break
      case "session.compaction.ended":
        handleCompactionEnded(event, eventCtx)
        break
      case "session.compaction.failed":
        handleCompactionFailed(event, eventCtx)
        break
      case "session.text.ended":
        handleTextEnded(event, eventCtx)
        break
      case "session.step.ended":
        handleStepEnded(event, eventCtx)
        break
      case "session.step.failed":
        handleStepFailed(event, eventCtx)
        break
      case "session.tool.input.started":
        handleToolInputStarted(event, eventCtx)
        break
      case "session.tool.called":
        handleToolCalled(event, eventCtx)
        break
      case "session.tool.progress":
        handleToolProgress(event, eventCtx)
        break
      case "session.tool.success":
        handleToolSuccess(event, eventCtx)
        break
      case "session.tool.failed":
        handleToolFailed(event, eventCtx)
        break
      case "permission.asked":
        handlePermissionAsked(event, eventCtx)
        break
      case "permission.replied":
        handlePermissionReplied(event, eventCtx)
        break
      default:
        break
    }
  }

  const controller = new AbortController()
  const running = consumeEvents(
    ctx.event.subscribe({ signal: controller.signal }),
    tracing,
    dispatch,
    async (event, err) => {
      recordDispatchError(shared.providers.health, event.type)
      await log("error", "otel: failed to handle event", {
        type: event.type,
        error: err instanceof Error ? err.message : String(err),
      })
    },
  ).catch(async (err) => {
      if (!controller.signal.aborted) {
        await log("error", "otel: event subscription ended", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

  return async () => {
    if (guardTeardown) await guardTeardown()
    controller.abort()
    await running.catch(() => {})
    // Only the last instance in the process may end spans: a reloaded instance keeps the
    // persisted context and continues the same trace.
    if (shared.refs <= 1) finalizeOnShutdown(hctx)
    await flush.drain()
    await releaseSharedOtel()
  }
}
