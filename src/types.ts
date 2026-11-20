import type { Context, Counter, Histogram, Span, SpanContext, Tracer } from "@opentelemetry/api"
import type { LogRecord, Logger } from "@opentelemetry/api-logs"
import type { Plugin } from "@opencode/plugin"
import type { OtelProviders } from "./otel.ts"
import type { SemconvFlavor } from "./semconv.ts"
import type { ToolSemantics } from "./facts.ts"
import type { TraceStore } from "./trace-store.ts"

/** Numeric priority map for log levels; higher value = higher severity. */
export const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const

/** Union of supported log level names. */
export type Level = keyof typeof LEVELS

/** Maximum number of entries kept in bounded correlation maps. */
export const MAX_PENDING = 500

/** The OpenCode V2 plugin context passed to `setup`. */
export type OpenCodeContext = Plugin.Context

type SubscribeResult = ReturnType<OpenCodeContext["event"]["subscribe"]>

/** A single OpenCode V2 server event, as yielded by `ctx.event.subscribe()`. */
export type OpenCodeEvent = SubscribeResult extends AsyncIterable<infer E> ? E : never

/** Narrows {@link OpenCodeEvent} to a single `type` discriminant. */
export type EventOf<T extends OpenCodeEvent["type"]> = Extract<OpenCodeEvent, { type: T }>

/** Structured logger for plugin diagnostics, forwarded to the server console. */
export type PluginLogger = (
  level: Level,
  message: string,
  extra?: Record<string, unknown>,
) => Promise<void>

/** OTel attributes common to every emitted span, log, and metric. */
export type CommonAttrs = Readonly<Record<string, string>>

/** In-flight permission prompt tracked between `permission.asked` and `permission.replied`. */
export type PendingPermission = {
  action: string
  resources: string[]
  sessionID: string
  /** Tool call id reported by `permission.asked.source`, when present. */
  toolCallID?: string
  /** Assistant message id that requested the permission, when present. */
  messageID?: string
}

/** Prompt text captured on the `prompt` hook and attached to the next run span. */
export type PendingPrompt = {
  text: string
  startMs: number
  /** SHA-256 of the prompt text, so a backend can group prompts without the content. */
  hash?: string
  /** Skill names hit by this prompt, attached to the run span that consumes it. */
  skills?: string[]
}

/** Factual tool metadata derived from tool arguments: no content, no judgement. */
export type ToolFacts = {
  /** Operation reported for file tools, e.g. `read`, `write`, `edit`, `list`, `glob`, `search`. */
  operation?: string
  /** Paths reported for file tools, in argument order. */
  paths?: string[]
  /** Command reported for shell tools, verbatim. */
  command?: string
}

/** OTel metric instruments created once at plugin startup and shared via `HandlerContext`. */
export type Instruments = {
  sessionCounter: Counter
  tokenCounter: Counter
  costCounter: Counter
  commitCounter: Counter
  toolDurationHistogram: Histogram
  cacheCounter: Counter
  sessionDurationHistogram: Histogram
  messageCounter: Counter
  sessionTokenHistogram: Histogram
  sessionCostHistogram: Histogram
  modelUsageCounter: Counter
  retryCounter: Counter
  subtaskCounter: Counter
  ttftHistogram: Histogram
  /** `gen_ai.execute_tool.duration`; recorded only in the `gen_ai` flavor. */
  executeToolDurationHistogram: Histogram
  /** `gen_ai.client.inference.duration`; recorded only in the `gen_ai` flavor. */
  inferenceDurationHistogram: Histogram
  /** `gen_ai.client.inference.usage.input_tokens`; recorded only in the `gen_ai` flavor. */
  inputTokensCounter: Counter
  /** `gen_ai.client.inference.usage.output_tokens`; recorded only in the `gen_ai` flavor. */
  outputTokensCounter: Counter
  /** `gen_ai.client.inference.usage.cache_read.input_tokens`; recorded only in the `gen_ai` flavor. */
  cacheReadTokensCounter: Counter
  /** `gen_ai.client.inference.usage.cache_write.input_tokens`; recorded only in the `gen_ai` flavor. */
  cacheWriteTokensCounter: Counter
  /** `gen_ai.client.inference.usage.reasoning.output_tokens`; recorded only in the `gen_ai` flavor. */
  reasoningTokensCounter: Counter
  /** `{prefix}exporter.export.failures`; one increment per failed export batch. */
  exporterFailureCounter: Counter
  /** `{prefix}exporter.auth.retry.count`; one increment per header refresh after an auth failure. */
  exporterAuthRetryCounter: Counter
  /** `{prefix}event.dispatch.errors`; one increment per failed event dispatch. */
  eventDispatchErrorCounter: Counter
  /** `{prefix}flush.failures`; one increment per scheduled flush with a failed provider. */
  flushFailureCounter: Counter
  /** `{prefix}flush.duration`; one record per scheduled flush. */
  flushDurationHistogram: Histogram
  /** `{prefix}guard.decisions`; one increment per permission.evaluate guard decision. */
  guardDecisionsCounter: Counter
  /** `{prefix}guard.tool.actions`; tool before/after guard actions (staged/allowlist/redacted/tool_error). */
  guardToolActionsCounter: Counter
}

/** Session role emitted by opencode: either the primary/root agent or a spawned subagent. */
export type SessionAgentType = "primary" | "subagent"

/** Accumulated per-session totals used for gauge snapshots at execution end. */
export type SessionTotals = {
  startMs: number
  tokens: number
  cost: number
  messages: number
  agent: string
  agentType: SessionAgentType
  agentVersion?: string
  parentID?: string
}

export type SessionIdentity = {
  agent: string
  agentType: SessionAgentType
  agentVersion?: string
  parentID?: string
  startMs: number
  tokens?: number
  cost?: number
  messages?: number
}

/** Model/agent metadata for an in-flight LLM step, keyed by assistant message ID. */
export type StepMeta = {
  sessionID: string
  startMs: number
  /** Timestamp of the earliest streamed output part (text, reasoning, or tool input). */
  firstTokenAt?: number
  agent: string
  agentType: SessionAgentType | "unknown"
  agentVersion?: string
  modelID: string
  providerID: string
  /** Turn id of the owning execution, inherited by its tool calls. */
  turnID?: string
}

/** Metadata for an in-flight tool call keyed by tool call id. */
export type ToolMeta = {
  sessionID: string
  assistantMessageID: string
  tool: string
  startMs: number
  executionStarted?: boolean
  command?: string
  agent?: string
  childSessionID?: string
  /** Execution sequence inherited from the owning step. */
  turnID?: string
  /** Assistant message id of the owning step. */
  stepID?: string
  /** Factual tool metadata captured when the call was observed. */
  toolFacts?: ToolFacts
  /** SHA-256 of the serialized tool arguments. */
  argsHash?: string
  /** Attachment and destination facts derived from the tool arguments. */
  semantics?: ToolSemantics
  /** Result metadata reported by opencode when the tool finished. */
  resultMetadata?: Record<string, unknown>
}

/** Toolset fingerprint reported by the model-visible request. */
export type ToolsetFingerprint = {
  hash: string
  tools: string[]
}

/** Live LLM request metadata used by the `model.request` trace-propagation hook. */
export type LlmRequestContext = {
  agent: string
  modelID: string
  providerID: string
  spanContext: SpanContext
}

/** A single text-only message retained from the model-visible request, for span attributes. */
export type MessageEntry = {
  role: string
  content: string
}

/** Bounded model-visible text snapshot awaiting its matching primary request. */
export type ModelContextSnapshot = {
  agent: string
  providerID: string
  modelID: string
  entries: MessageEntry[]
  inputValue?: string
  /** Serialized full model-visible context, present only when `OPENCODE_CAPTURE_CONTEXT_SNAPSHOT` is on. */
  full?: string
}

/**
 * Per-process shared OTel SDK instance. OpenCode loads a plugin instance per
 * location but the OTel global providers may only be registered once, so the
 * providers, instruments, logger, and tracer are shared via `globalThis`.
 */
export type SharedOtel = {
  providers: OtelProviders
  instruments: Instruments
  logger: Logger
  tracer: Tracer
  refs: number
  configKey: string
}

/**
 * Per-process tracing correlation state. Span ids are unique across the
 * process, so a single shared state keeps parent lookups consistent when
 * multiple plugin instances observe the same stream.
 */
export type TracingState = {
  seenEvents: Set<string>
  eventQueue: Promise<void>
  runSpans: Map<string, Span>
  runSpanContexts: Map<string, SpanContext>
  stepSpans: Map<string, Span>
  activeStepSpans: Map<string, Span>
  stepSpanContexts: Map<string, SpanContext>
  toolSpans: Map<string, Span>
  toolSpanContexts: Map<string, SpanContext>
  subagentParents: Map<string, { spanContext: SpanContext; callID: string }>
  consumedSubagentDispatches: Set<string>
  toolMeta: Map<string, ToolMeta>
  stepMeta: Map<string, StepMeta>
  sessionTotals: Map<string, SessionTotals>
  countedSessions: Set<string>
  countedMessages: Set<string>
  sessionProjects: Map<string, string>
  sessionIdentity: Map<string, SessionIdentity>
  /** Latest model-visible toolset fingerprint per session. */
  sessionToolsets: Map<string, ToolsetFingerprint>
  /** Model ids observed per session, used for the agent configuration fingerprint. */
  sessionModels: Map<string, Set<string>>
  /** Last observed execution (turn) sequence per session, used to build `gen_ai.turn.id`. */
  sessionTurns: Map<string, number>
  /** Retries observed in the current execution per session, used for `session.retry.count`. */
  sessionRetries: Map<string, number>
  stepOutputs: Map<string, Map<number, string>>
  /** Reasoning text streamed per step, in ordinal order, awaiting the step end. */
  stepReasoning: Map<string, Map<number, string>>
  /** Assistant text accumulated for the current execution, attached to the run span output. */
  turnOutputs: Map<string, string>
  /** In-flight context compaction span per session. */
  compactionSpans: Map<string, Span>
  /** Start time and reason of the in-flight compaction, keyed like {@link compactionSpans}. */
  compactionMeta: Map<string, { startMs: number; reason: string }>
  pendingPrompts: Map<string, PendingPrompt[]>
  activePrompts: Map<string, PendingPrompt>
  activeExecutions: Set<string>
  pendingPermissions: Map<string, PendingPermission>
  activeLlm: Map<string, LlmRequestContext>
  provisionalLlm: Map<string, Span>
  modelContexts: Map<string, ModelContextSnapshot>
  /** Run/step span contexts restored from a previous plugin instance, keyed by session. */
  restoredRunContexts: Map<string, SpanContext>
  /** Step span contexts restored from a previous plugin instance, keyed by assistant message. */
  restoredStepContexts: Map<string, { sessionID: string; spanContext: SpanContext }>
  /** In-flight or completed storage restores per session, so a session is loaded once. */
  restorePromises: Map<string, Promise<void>>
}

/** Shared context threaded through every event handler. */
export type HandlerContext = {
  log: PluginLogger
  /**
   * Emits a log event. Events that duplicate a span are dropped in the `gen_ai` flavor only
   * when `OPENCODE_EMIT_REDUNDANT_EVENTS` (or the `emitRedundantEvents` option) is disabled.
   */
  emitEvent: (record: LogRecord, spanContext?: SpanContext) => void
  instruments: Instruments
  commonAttrs: CommonAttrs
  disabledMetrics: Set<string>
  disabledTraces: Set<string>
  semconv: SemconvFlavor
  /** Agent runtime version recorded as `gen_ai.agent.version`; omitted when unknown. */
  agentVersion?: string
  /** Whether message/tool content may be serialized into spans and logs. */
  captureContent: boolean
  /** Whether factual tool metadata (command, file paths) may be emitted. */
  captureToolFacts: boolean
  /** Whether the full model-visible context may be attached to the LLM span. */
  captureContextSnapshot: boolean
  tracer: Tracer
  tracePrefix: string
  rootContext: () => Context
  tracing: TracingState
  tracePropagationProviders: Set<string>
  /** Persists the run/step span context across plugin instance replacement. */
  traceStore?: TraceStore
}
