import { isSpanContextValid, ROOT_CONTEXT, trace, type Attributes, type Context, type SpanContext } from "@opentelemetry/api"
import { MAX_PENDING, type HandlerContext, type SessionAgentType, type TracingState } from "./types.ts"

const MAX_SEEN_EVENTS = 10_000

/** Maximum number of characters retained in a single content-bearing attribute. */
export const CONTENT_LIMIT = 20_000

const GEN_AI_PROVIDER_NAMES: Readonly<Record<string, string>> = {
  "amazon-bedrock": "aws.bedrock",
  azure: "azure.ai.openai",
  "azure-cognitive-services": "azure.ai.openai",
  google: "gcp.gemini",
  "google-vertex": "gcp.vertex_ai",
  "google-vertex-anthropic": "gcp.vertex_ai",
  mistral: "mistral_ai",
  xai: "x_ai",
}

/** A structured error as emitted by the OpenCode V2 event stream. */
export type StructuredError = { type: string; message: string; status?: number }

/** Token counts as emitted by the OpenCode V2 event stream. */
export type TokenInfo = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

/** A `{ providerID, id }` model reference as emitted by the OpenCode V2 event stream. */
export type ModelRef = { providerID: string; id: string; variant?: string }

/** Returns a human-readable summary string from a structured error payload. */
export function errorSummary(err: StructuredError | undefined): string {
  if (!err) return "unknown"
  return `${err.type}: ${err.message}`
}

/** A content string together with its truncation state. */
export type Truncated = {
  text: string
  truncated: boolean
  originalLength: number
}

/**
 * Truncates a content value to `limit` Unicode code points and reports whether it was cut
 * and how long the original was. Cutting by code point keeps surrogate pairs intact.
 */
export function truncateContent(value: string | undefined, limit = CONTENT_LIMIT): Truncated {
  if (!value) return { text: "", truncated: false, originalLength: 0 }
  const chars = Array.from(value)
  if (chars.length <= limit) return { text: value, truncated: false, originalLength: chars.length }
  return { text: chars.slice(0, limit).join(""), truncated: true, originalLength: chars.length }
}

/**
 * Returns the truncation marker attributes for a content field. Nothing is written for an
 * untruncated value, so a backend can distinguish "absent" from "not cut".
 */
export function truncationAttrs(field: string, value: Truncated): Attributes {
  if (!value.truncated) return {}
  return {
    [`${field}.truncated`]: true,
    [`${field}.original_length`]: value.originalLength,
  }
}

/**
 * Normalizes a list of fact names: trims, drops empties, removes duplicates while keeping
 * the first occurrence, caps each entry and the list length.
 */
export function normalizeNames(values: readonly string[] | undefined, maxItems: number, maxLength: number): string[] {
  if (!values) return []
  const names: string[] = []
  for (const value of values) {
    const name = value.trim().slice(0, maxLength)
    if (!name || names.includes(name)) continue
    names.push(name)
    if (names.length >= maxItems) break
  }
  return names
}

function turnID(sessionID: string, seq: number): string {
  return `${sessionID}:${seq}`
}

/**
 * Allocates the next execution (turn) sequence for a session and returns its id.
 * Ids are `sessionID:seq` so merging sessions into one backend never collides.
 */
export function nextTurnID(sessionID: string, ctx: HandlerContext): string {
  const seq = (ctx.tracing.sessionTurns.get(sessionID) ?? 0) + 1
  setBoundedMap(ctx.tracing.sessionTurns, sessionID, seq)
  return turnID(sessionID, seq)
}

/** Returns the id of the session's current execution (turn), if one has started. */
export function currentTurnID(sessionID: string, ctx: HandlerContext): string | undefined {
  const seq = ctx.tracing.sessionTurns.get(sessionID)
  return seq ? turnID(sessionID, seq) : undefined
}

/** Returns the canonical OTel GenAI provider name, preserving unknown provider IDs. */
export function genAiProviderName(providerID: string): string {
  return GEN_AI_PROVIDER_NAMES[providerID] ?? providerID
}

/** Sums billed tokens for a usage sample, excluding cache reads/writes. */
export function totalTokens(tokens: TokenInfo | undefined): number {
  if (!tokens) return 0
  return (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0)
}

/** Formats a model reference as `provider/id`, defaulting to `unknown`. */
export function modelRef(model: ModelRef | undefined): string {
  return model ? `${model.providerID}/${model.id}` : "unknown"
}

/**
 * Inserts a key/value pair into `map`, evicting the oldest entry first when the map
 * has reached `MAX_PENDING` capacity to prevent unbounded memory growth.
 */
export function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V) {
  if (!map.has(key) && map.size >= MAX_PENDING) {
    const [firstKey] = map.keys()
    if (firstKey !== undefined) map.delete(firstKey)
  }
  map.set(key, value)
}

/**
 * Records the earliest streamed output timestamp for an in-flight LLM step.
 * Text, reasoning, and tool-input events all count as the first model output.
 */
export function recordFirstToken(assistantMessageID: string, at: number, ctx: HandlerContext) {
  const meta = ctx.tracing.stepMeta.get(assistantMessageID)
  if (!meta) return
  const firstTokenAt = Math.min(meta.firstTokenAt ?? at, at)
  setBoundedMap(ctx.tracing.stepMeta, assistantMessageID, { ...meta, firstTokenAt })
}

/** Records an event id for de-duplication, evicting the oldest entry when at capacity. */
export function markSeen(seen: TracingState["seenEvents"], id: string): void {
  if (!seen.has(id) && seen.size >= MAX_SEEN_EVENTS) {
    const [first] = seen.values()
    if (first !== undefined) seen.delete(first)
  }
  seen.add(id)
}

export function enqueueEvent(state: TracingState, id: string, handle: () => Promise<void>): Promise<void> {
  const task = state.eventQueue.then(async () => {
    if (state.seenEvents.has(id)) return
    await handle()
    markSeen(state.seenEvents, id)
  })
  state.eventQueue = task.catch(() => {})
  return task
}

/** Enqueues subscription events without blocking the reader while preserving shared dispatch order. */
export async function consumeEvents<T extends { id: string }>(
  events: AsyncIterable<T>,
  state: TracingState,
  dispatch: (event: T) => Promise<void>,
  onError: (event: T, error: unknown) => Promise<void>,
): Promise<void> {
  let last = Promise.resolve()
  try {
    for await (const event of events) {
      last = enqueueEvent(state, event.id, () => dispatch(event)).catch((error) => onError(event, error))
    }
  } finally {
    await last
  }
}

/**
 * Returns `true` if the metric name (without prefix) is not in the disabled set.
 * The `name` should be the suffix after the metric prefix, e.g. `"session.count"`.
 */
export function isMetricEnabled(name: string, ctx: { disabledMetrics: Set<string> }): boolean {
  return !ctx.disabledMetrics.has(name)
}

/**
 * Returns `true` if the trace type is not in the disabled set.
 * Valid names are `"session"`, `"llm"`, and `"tool"`.
 */
export function isTraceEnabled(name: string, ctx: { disabledTraces: Set<string> }): boolean {
  return !ctx.disabledTraces.has(name)
}

/** Resolves the trace context for a run span, falling back to the configured root context. */
export function resolveRunContext(sessionID: string, ctx: HandlerContext): Context {
  const base = ctx.rootContext()
  const span = ctx.tracing.runSpans.get(sessionID)
  if (span) return trace.setSpan(base, span)
  const spanContext = ctx.tracing.runSpanContexts.get(sessionID) ?? ctx.tracing.restoredRunContexts.get(sessionID)
  return spanContext ? trace.setSpanContext(base, spanContext) : base
}

/** Resolves the trace context for a step span, falling back to its run context. */
export function resolveStepContext(sessionID: string, assistantMessageID: string, ctx: HandlerContext): Context {
  const parent = resolveRunContext(sessionID, ctx)
  const span = ctx.tracing.stepSpans.get(assistantMessageID)
  if (span) return trace.setSpan(parent, span)
  const spanContext = ctx.tracing.stepSpanContexts.get(assistantMessageID) ?? ctx.tracing.restoredStepContexts.get(assistantMessageID)?.spanContext
  return spanContext ? trace.setSpanContext(parent, spanContext) : parent
}

/**
 * Restores the run/step span context persisted by a previous plugin instance, once per
 * session. A plugin reload (config change, project switch) recreates the instance while a
 * turn is still running; without this the remaining spans of that turn would start a new
 * trace instead of joining the exported one.
 */
export function restoreSessionTraceContext(sessionID: string, ctx: HandlerContext): Promise<void> {
  const store = ctx.traceStore
  if (!store) return Promise.resolve()
  const existing = ctx.tracing.restorePromises.get(sessionID)
  if (existing) return existing
  const pending = (async () => {
    const restored = await store.load(sessionID)
    if (!restored) return
    if (restored.run && !ctx.tracing.runSpanContexts.has(sessionID)) {
      setBoundedMap(ctx.tracing.restoredRunContexts, sessionID, restored.run)
    }
    if (restored.step && !ctx.tracing.stepSpanContexts.has(restored.step.messageID)) {
      setBoundedMap(ctx.tracing.restoredStepContexts, restored.step.messageID, {
        sessionID,
        spanContext: restored.step.spanContext,
      })
    }
  })()
  setBoundedMap(ctx.tracing.restorePromises, sessionID, pending)
  return pending
}

/**
 * Returns the tool call id that dispatched `sessionID` as a subagent, when the correlation
 * is known from live progress or a completed dispatch. Must be called before
 * {@link resolveSubagentTraceContext} consumes the pending correlation.
 */
export function subagentDispatchCallID(sessionID: string, ctx: HandlerContext): string | undefined {
  const exact = ctx.tracing.subagentParents.get(sessionID)?.callID
  if (exact) return exact
  for (const [callID, meta] of ctx.tracing.toolMeta) {
    if (meta.tool === "subagent" && meta.childSessionID === sessionID) return callID
  }
  return undefined
}

/** Resolves a child run under its correlated dispatch tool, falling back to the parent run. */
export function resolveSubagentTraceContext(sessionID: string, parentID: string, agent: string, ctx: HandlerContext): Context {
  const exact = ctx.tracing.subagentParents.get(sessionID)
  if (exact) {
    ctx.tracing.subagentParents.delete(sessionID)
    markSeen(ctx.tracing.consumedSubagentDispatches, exact.callID)
    return trace.setSpanContext(ctx.rootContext(), exact.spanContext)
  }
  const candidates = [...ctx.tracing.toolMeta]
    .filter(([id, meta]) => meta.sessionID === parentID && meta.tool === "subagent"
      && (!meta.childSessionID || meta.childSessionID === sessionID)
      && !ctx.tracing.consumedSubagentDispatches.has(id)
      && (!meta.agent || agent === "unknown" || meta.agent === agent) && ctx.tracing.toolSpans.has(id))
  if (candidates.length === 1) {
    const callID = candidates[0]![0]
    markSeen(ctx.tracing.consumedSubagentDispatches, callID)
    const span = ctx.tracing.toolSpans.get(callID)!
    return trace.setSpan(ctx.rootContext(), span)
  }
  return resolveRunContext(parentID, ctx)
}

/**
 * Builds the log-record context that correlates an emitted event with `spanContext`.
 * The OTel logs SDK stamps `traceId`/`spanId` from the record context (falling back to
 * `context.active()`, which is the root context here because handlers never activate
 * their spans), so events must carry the context explicitly.
 */
export function eventContext(spanContext: SpanContext | undefined): Context | undefined {
  return spanContext && isSpanContextValid(spanContext) ? trace.setSpanContext(ROOT_CONTEXT, spanContext) : undefined
}

/**
 * Resolves the span context log events for `sessionID` should correlate with: the
 * session's own run, or the parent run for a subagent session that has not started.
 */
export function sessionSpanContext(sessionID: string, ctx: HandlerContext): SpanContext | undefined {
  const own = ctx.tracing.runSpanContexts.get(sessionID) ?? ctx.tracing.restoredRunContexts.get(sessionID)
  if (own) return own
  const parentID = ctx.tracing.sessionIdentity.get(sessionID)?.parentID
  return parentID ? ctx.tracing.runSpanContexts.get(parentID) ?? ctx.tracing.restoredRunContexts.get(parentID) : undefined
}

/** Maximum characters retained for the assistant text of one execution. */
const TURN_OUTPUT_LIMIT = 64_000

/** Appends assistant text to the current execution output, bounded for memory safety. */
export function appendTurnOutput(sessionID: string, text: string, ctx: HandlerContext): void {
  if (!text) return
  const current = ctx.tracing.turnOutputs.get(sessionID) ?? ""
  if (current.length >= TURN_OUTPUT_LIMIT) return
  const next = current ? `${current}\n${text}` : text
  setBoundedMap(ctx.tracing.turnOutputs, sessionID, next.slice(0, TURN_OUTPUT_LIMIT))
}

/** Resolves the current session-scoped agent name/type, defaulting to `unknown` when unavailable. */
export function getSessionAgentMeta(
  sessionID: string,
  ctx: HandlerContext,
): { agentName: string; agentType: SessionAgentType | "unknown"; agentVersion: string | undefined } {
  const totals = ctx.tracing.sessionTotals.get(sessionID)
  return {
    agentName: totals?.agent ?? "unknown",
    agentType: totals?.agentType ?? "unknown",
    agentVersion: totals?.agentVersion,
  }
}

export async function contextForSession(
  sessionID: string,
  ctx: HandlerContext,
  getSession: (sessionID: string) => Promise<{ projectID: string; agent?: string; parentID?: string; time: { created: number } }>,
): Promise<HandlerContext> {
  let projectID = ctx.tracing.sessionProjects.get(sessionID)
  if (!projectID || !ctx.tracing.sessionIdentity.has(sessionID)) {
    try {
      const session = await getSession(sessionID)
      projectID = session.projectID
      setBoundedMap(ctx.tracing.sessionProjects, sessionID, projectID)
      setBoundedMap(ctx.tracing.sessionIdentity, sessionID, {
        agent: session.agent ?? "unknown",
        agentType: session.parentID ? "subagent" : "primary",
        ...(session.parentID ? { parentID: session.parentID } : {}),
        startMs: session.time.created,
      })
    } catch {
      if (!projectID) return ctx
    }
  }
  return projectID ? { ...ctx, commonAttrs: { ...ctx.commonAttrs, "project.id": projectID } } : ctx
}
