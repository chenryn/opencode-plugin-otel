import type { Attributes } from "@opentelemetry/api"
import {
  AGENT_NAME,
  INPUT_MIME_TYPE,
  INPUT_VALUE,
  LLM_COST_TOTAL,
  LLM_INPUT_MESSAGES,
  LLM_MODEL_NAME,
  LLM_OUTPUT_MESSAGES,
  LLM_PROVIDER,
  LLM_SYSTEM,
  LLM_TOKEN_COUNT_COMPLETION,
  LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING,
  LLM_TOKEN_COUNT_PROMPT,
  LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ,
  LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE,
  LLM_TOKEN_COUNT_TOTAL,
  MimeType,
  OpenInferenceSpanKind,
  OUTPUT_MIME_TYPE,
  OUTPUT_VALUE,
  SemanticConventions,
  SESSION_ID,
  TOOL_ID,
  TOOL_NAME,
  TOOL_PARAMETERS,
} from "@arizeai/openinference-semantic-conventions"
import type { MessageEntry, ToolFacts } from "./types.ts"
import {
  errorSummary,
  genAiProviderName,
  truncateContent,
  truncationAttrs,
  type StructuredError,
  type TokenInfo,
} from "./util.ts"

/**
 * Wire-format dialect used for emitted span attributes.
 *
 * `openinference` (the default) keeps the OpenInference semantic conventions
 * (`openinference.span.kind`, `llm.*`, `tool.*`) that every existing dashboard and this
 * plugin's release line use. `gen_ai` emits the OpenTelemetry GenAI semantic conventions
 * (`gen_ai.operation.name`, `gen_ai.*`) natively, so no external collector transform is
 * required to feed a GenAI-native backend.
 */
export type SemconvFlavor = "openinference" | "gen_ai"

/** Flavor used when `OPENCODE_SEMCONV` and the `semconv` plugin option are both absent. */
export const DEFAULT_SEMCONV: SemconvFlavor = "openinference"

const SEMCONV_ALIASES: Readonly<Record<string, SemconvFlavor>> = {
  openinference: "openinference",
  "open-inference": "openinference",
  gen_ai: "gen_ai",
  "gen-ai": "gen_ai",
  genai: "gen_ai",
}

/** Human-readable list of accepted `OPENCODE_SEMCONV` values, for diagnostics. */
export const SEMCONV_VALUES = "openinference, gen_ai"

const OPENINFERENCE_SPAN_KIND = SemanticConventions.OPENINFERENCE_SPAN_KIND
const LLM_FINISH_REASON = "llm.finish_reason"

/**
 * Normalizes a configured flavor name. Returns `undefined` for unknown values so the
 * caller can warn and fall back to {@link DEFAULT_SEMCONV} instead of silently emitting
 * a partially translated span.
 */
export function parseSemconv(value: string | undefined): SemconvFlavor | undefined {
  if (!value) return undefined
  return SEMCONV_ALIASES[value.trim().toLowerCase()]
}

/**
 * Attribute keys from the OpenTelemetry GenAI semantic conventions emitted by the `gen_ai`
 * flavor. Most entries are written as literals for readability; `tests/semconv.test.ts`
 * asserts them against `@opentelemetry/semantic-conventions/incubating` so drift fails the
 * build. Keys marked as extensions have no official constant and the same test skips them.
 */
export const GEN_AI_ATTR = {
  operationName: "gen_ai.operation.name",
  providerName: "gen_ai.provider.name",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  responseFinishReasons: "gen_ai.response.finish_reasons",
  conversationID: "gen_ai.conversation.id",
  agentName: "gen_ai.agent.name",
  inputMessages: "gen_ai.input.messages",
  outputMessages: "gen_ai.output.messages",
  usageInputTokens: "gen_ai.usage.input_tokens",
  usageOutputTokens: "gen_ai.usage.output_tokens",
  usageCacheReadInputTokens: "gen_ai.usage.cache_read.input_tokens",
  usageCacheCreationInputTokens: "gen_ai.usage.cache_creation.input_tokens",
  tokenModality: "gen_ai.token.modality",
  timeToFirstToken: "gen_ai.server.time_to_first_token",
  toolName: "gen_ai.tool.name",
  toolCallID: "gen_ai.tool.call.id",
  toolCallArguments: "gen_ai.tool.call.arguments",
  toolCallResult: "gen_ai.tool.call.result",
  toolType: "gen_ai.tool.type",
  errorType: "error.type",
  /** Extension: per-session execution sequence, not an official GenAI key. */
  turnID: "gen_ai.turn.id",
  /** Extension: per-step assistant message sequence, not an official GenAI key. */
  stepID: "gen_ai.step.id",
  /** Extension: request cost in USD, not an official GenAI key. */
  usageCost: "gen_ai.usage.cost",
} as const

/** `gen_ai.operation.name` values used by this plugin. */
const OP_CHAT = "chat"
const OP_EXECUTE_TOOL = "execute_tool"
const OP_INVOKE_AGENT = "invoke_agent"

/**
 * Metric names from the OpenTelemetry GenAI semantic conventions emitted by the `gen_ai`
 * flavor. They follow the unreleased `semantic-conventions-genai` revision, whose inference
 * metrics replaced `gen_ai.client.token.usage` (histogram) with one monotonic counter per
 * token category and renamed `gen_ai.client.operation.duration` to
 * `gen_ai.client.inference.duration`. They are never prefixed: a prefixed name would no
 * longer match the convention.
 */
export const GEN_AI_METRIC = {
  timeToFirstToken: "gen_ai.server.time_to_first_token",
  executeToolDuration: "gen_ai.execute_tool.duration",
  inferenceDuration: "gen_ai.client.inference.duration",
  inputTokens: "gen_ai.client.inference.usage.input_tokens",
  outputTokens: "gen_ai.client.inference.usage.output_tokens",
  cacheReadInputTokens: "gen_ai.client.inference.usage.cache_read.input_tokens",
  cacheWriteInputTokens: "gen_ai.client.inference.usage.cache_write.input_tokens",
  reasoningOutputTokens: "gen_ai.client.inference.usage.reasoning.output_tokens",
} as const

/**
 * `gen_ai.token.modality` for prompt tokens. opencode reports one aggregate prompt count and
 * the provider does not split text from image or audio contributions, and the conventions
 * require `unknown` rather than a guess when the split cannot be recovered.
 */
export const PROMPT_TOKEN_MODALITY = "unknown"

/** `gen_ai.token.modality` for generated tokens: an inference response is text or reasoning text. */
export const OUTPUT_TOKEN_MODALITY = "text"

/**
 * Log events that duplicate information already carried by a span. They are emitted by
 * default so audit timelines keep every lifecycle marker; setting
 * `OPENCODE_EMIT_REDUNDANT_EVENTS=0` suppresses them in the `gen_ai` flavor so a backend
 * counting both signals does not double count requests, tool calls, or sessions.
 */
const REDUNDANT_EVENTS: ReadonlySet<string> = new Set([
  "api_request",
  "api_error",
  "tool_result",
  "session.created",
])

/** Returns `true` when the log event is redundant with a span and may be suppressed. */
export function isEventSuppressed(flavor: SemconvFlavor, eventName: string): boolean {
  return flavor === "gen_ai" && REDUNDANT_EVENTS.has(eventName)
}

/** Identity attributes shared by log events and metric data points. */
export type SignalIdentity = {
  sessionID?: string
  agent?: string
  agentType?: string
  modelID?: string
  providerID?: string
  tool?: string
}

/**
 * Builds the identity attributes for a log event or metric data point. `session.id` is kept
 * in both flavors as the cross-signal join key; every other key is swapped for its GenAI
 * equivalent so a GenAI-native backend can group without a translation layer.
 */
export function signalAttrs(flavor: SemconvFlavor, input: SignalIdentity): Attributes {
  const attrs: Attributes = {}
  if (input.sessionID) attrs[SESSION_ID] = input.sessionID
  if (input.tool) attrs[flavor === "gen_ai" ? GEN_AI_ATTR.toolName : "tool_name"] = input.tool
  if (input.modelID) attrs[flavor === "gen_ai" ? GEN_AI_ATTR.requestModel : "model"] = input.modelID
  if (input.providerID) {
    attrs[flavor === "gen_ai" ? GEN_AI_ATTR.providerName : "provider"] = flavor === "gen_ai"
      ? genAiProviderName(input.providerID)
      : input.providerID
  }
  if (input.agent) {
    if (flavor === "gen_ai") attrs[GEN_AI_ATTR.agentName] = input.agent
    else {
      attrs["agent"] = input.agent
      attrs[AGENT_NAME] = input.agent
    }
  }
  if (input.agentType) attrs["agent.type"] = input.agentType
  if (input.sessionID && flavor === "gen_ai") attrs[GEN_AI_ATTR.conversationID] = input.sessionID
  return attrs
}

/** Attributes for the GenAI inference metrics recorded from a step. */
export function inferenceMetricAttrs(input: SignalIdentity & { errorType?: string }): Attributes {
  const attrs = signalAttrs("gen_ai", input)
  attrs[GEN_AI_ATTR.operationName] = OP_CHAT
  if (input.errorType) attrs[GEN_AI_ATTR.errorType] = input.errorType
  return attrs
}

/** Attributes for `gen_ai.execute_tool.duration`; `error.type` is set only for a failed tool. */
export function toolDurationAttrs(input: SignalIdentity & { success: boolean; errorType?: string }): Attributes {
  const attrs = signalAttrs("gen_ai", input)
  attrs[GEN_AI_ATTR.toolType] = "function"
  if (!input.success) attrs[GEN_AI_ATTR.errorType] = input.errorType ?? "error"
  return attrs
}

/** Adds the required `gen_ai.token.modality` attribute to a token counter measurement. */
export function withTokenModality(attrs: Attributes, modality: string): Attributes {
  return { ...attrs, [GEN_AI_ATTR.tokenModality]: modality }
}

/**
 * Cost attributes for a span or log event. The `gen_ai` flavor reports the extension key
 * `gen_ai.usage.cost` (in USD) and drops the bare `cost_usd` key so a single value is queryable;
 * the `openinference` flavor keeps `cost_usd` for existing dashboards.
 */
export function costAttrs(flavor: SemconvFlavor, cost: number): Attributes {
  return flavor === "gen_ai" ? { [GEN_AI_ATTR.usageCost]: cost } : { cost_usd: cost }
}

/**
 * Structured error attributes preserved verbatim from the event payload. `error.type` is the
 * grouping key for negative-sample rules; `error.message` and `error.status` keep the details
 * that a flattened `"type: message"` summary would lose.
 */
export function errorAttrs(err: StructuredError | undefined): Attributes {
  if (!err) return {}
  return {
    [GEN_AI_ATTR.errorType]: err.type,
    "error.message": err.message,
    ...(err.status !== undefined ? { "error.status": err.status } : {}),
  }
}

/**
 * Attributes recorded when opencode schedules an API retry. `retry.attempt` is the attempt
 * number carried by the durable event; `count` is the number of retries observed in the
 * current execution and is written to the run span only; `error.type` groups retries by cause.
 */
export type RetryInput = {
  attempt: number
  count?: number
  error?: StructuredError
}

/** Returns the attributes recorded for a scheduled API retry. */
export function retryAttrs(input: RetryInput): Attributes {
  return {
    "retry.attempt": input.attempt,
    ...(input.count !== undefined ? { "session.retry.count": input.count } : {}),
    ...errorAttrs(input.error),
  }
}

/** Agent identity attributes for the active flavor. */
function agentNameAttrs(flavor: SemconvFlavor, agent: string): Attributes {
  return flavor === "gen_ai" ? { [GEN_AI_ATTR.agentName]: agent } : { [AGENT_NAME]: agent }
}

/** Session/conversation identity attributes for the active flavor. */
function conversationAttrs(flavor: SemconvFlavor, sessionID: string): Attributes {
  return flavor === "gen_ai"
    ? { [GEN_AI_ATTR.conversationID]: sessionID, [SESSION_ID]: sessionID }
    : { [SESSION_ID]: sessionID }
}

/** Span name for a run (agent) span. */
export function agentSpanName(flavor: SemconvFlavor, agent: string, prefix: string): string {
  return flavor === "gen_ai" ? `${OP_INVOKE_AGENT} ${agent}` : `${prefix}session`
}

/** Span name for an LLM request span. */
export function llmSpanName(flavor: SemconvFlavor, modelID: string, prefix: string): string {
  return flavor === "gen_ai" ? `${OP_CHAT} ${modelID}` : `${prefix}llm`
}

/** Span name for a tool execution span. */
export function toolSpanName(flavor: SemconvFlavor, tool: string, prefix: string): string {
  return flavor === "gen_ai" ? `${OP_EXECUTE_TOOL} ${tool}` : `${prefix}tool.${tool}`
}

/**
 * Serializes captured model input messages in the shape the active flavor expects:
 * OpenInference keeps a flat `{role, content}` array, GenAI uses `{role, parts}`.
 * Each message is capped at the shared content limit; the marker reports the sum of the
 * original message lengths so a truncated snapshot is never silent.
 */
export function inputMessageAttrs(flavor: SemconvFlavor, entries: readonly MessageEntry[]): Attributes {
  const truncated = entries.map((entry) => truncateContent(entry.content))
  const marker = truncationAttrs("content.input", {
    text: "",
    truncated: truncated.some((entry) => entry.truncated),
    originalLength: truncated.reduce((sum, entry) => sum + entry.originalLength, 0),
  })
  if (flavor === "gen_ai") {
    return {
      [GEN_AI_ATTR.inputMessages]: JSON.stringify(entries.map((entry, index) => ({
        role: entry.role,
        parts: [{ type: "text", content: truncated[index]!.text }],
      }))),
      ...marker,
    }
  }
  return {
    [LLM_INPUT_MESSAGES]: JSON.stringify(entries.map((entry, index) => ({ role: entry.role, content: truncated[index]!.text }))),
    ...marker,
  }
}

/** Attributes for a single observed user prompt. */
export function promptAttrs(flavor: SemconvFlavor, text: string): Attributes {
  const value = truncateContent(text)
  if (flavor === "gen_ai") return inputMessageAttrs(flavor, [{ role: "user", content: text }])
  return {
    [INPUT_VALUE]: value.text,
    [INPUT_MIME_TYPE]: MimeType.TEXT,
    [LLM_INPUT_MESSAGES]: JSON.stringify([{ role: "user", content: value.text }]),
    ...truncationAttrs("content.input", value),
  }
}

/** Attributes for the assistant output of a completed or failed LLM request. */
export function outputAttrs(flavor: SemconvFlavor, text: string, finishReason?: string): Attributes {
  const value = truncateContent(text)
  if (flavor === "gen_ai") {
    return {
      [GEN_AI_ATTR.outputMessages]: JSON.stringify([{
        role: "assistant",
        parts: [{ type: "text", content: value.text }],
        ...(finishReason ? { finish_reason: finishReason } : {}),
      }]),
      ...truncationAttrs("content.output", value),
    }
  }
  return {
    [OUTPUT_VALUE]: value.text,
    [OUTPUT_MIME_TYPE]: MimeType.TEXT,
    [LLM_OUTPUT_MESSAGES]: JSON.stringify([{ role: "assistant", content: value.text }]),
    ...truncationAttrs("content.output", value),
  }
}

/** Attributes for partial assistant output on a failed request; no finish reason is known. */
function failureOutputAttrs(flavor: SemconvFlavor, text: string): Attributes {
  const value = truncateContent(text)
  if (flavor === "gen_ai") {
    return {
      [GEN_AI_ATTR.outputMessages]: JSON.stringify([{ role: "assistant", parts: [{ type: "text", content: value.text }] }]),
      ...truncationAttrs("content.output", value),
    }
  }
  return { [OUTPUT_VALUE]: value.text, [OUTPUT_MIME_TYPE]: MimeType.TEXT, ...truncationAttrs("content.output", value) }
}

/** Start attributes for a run (agent) span. */
export type AgentSpanInput = {
  sessionID: string
  agent: string
  agentType: string
  isSubagent: boolean
  /** Plugin extension: execution sequence inside the session, emitted in `gen_ai` only. */
  turnID?: string
  /** Plugin extension: session that dispatched this subagent run, when known. */
  parentSessionID?: string
  /** Plugin extension: dispatch tool call that spawned this subagent run, when known. */
  parentToolCallID?: string
  /** Skill names hit by the prompt that started this run, emitted in both flavors. */
  skillNames?: readonly string[]
  promptText?: string
}

/** Returns the start attributes for a run (agent) span. */
export function agentStartAttrs(flavor: SemconvFlavor, input: AgentSpanInput): Attributes {
  const shared = {
    ...conversationAttrs(flavor, input.sessionID),
    ...agentNameAttrs(flavor, input.agent),
    "agent.type": input.agentType,
    "session.is_subagent": input.isSubagent,
    ...(input.parentSessionID ? { "parent_session_id": input.parentSessionID } : {}),
    ...(input.parentToolCallID ? { "parent_tool_call_id": input.parentToolCallID } : {}),
    ...(input.skillNames?.length ? { "skill.name": [...input.skillNames] } : {}),
  }
  return {
    ...(flavor === "gen_ai" ? { [GEN_AI_ATTR.operationName]: OP_INVOKE_AGENT } : { [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT }),
    ...shared,
    ...(flavor === "gen_ai" && input.turnID ? { [GEN_AI_ATTR.turnID]: input.turnID } : {}),
    ...(input.promptText ? promptAttrs(flavor, input.promptText) : {}),
  }
}

/** Session totals attached to a run span when the execution ends. */
export type AgentTotals = {
  agent: string
  agentType: string
  tokens: number
  cost: number
  messages: number
}

/** Returns the session totals attached to a run span when its execution ends. */
export function agentEndAttrs(flavor: SemconvFlavor, totals: AgentTotals): Attributes {
  return {
    ...agentNameAttrs(flavor, totals.agent),
    "agent.type": totals.agentType,
    "session.total_tokens": totals.tokens,
    "session.total_cost_usd": totals.cost,
    ...(flavor === "gen_ai" ? costAttrs(flavor, totals.cost) : {}),
    "session.total_messages": totals.messages,
  }
}

/** Start attributes for an LLM request span. */
export type LlmSpanInput = {
  sessionID: string
  agent: string
  agentType?: string
  providerID: string
  modelID: string
  /** Plugin extension: execution sequence inside the session, emitted in `gen_ai` only. */
  turnID?: string
  /** Plugin extension: assistant message id for this step, emitted in `gen_ai` only. */
  stepID?: string
  promptText?: string
}

/** Returns the start attributes for an LLM request span. */
export function llmStartAttrs(flavor: SemconvFlavor, input: LlmSpanInput): Attributes {
  const provider = genAiProviderName(input.providerID)
  const shared = {
    ...conversationAttrs(flavor, input.sessionID),
    ...agentNameAttrs(flavor, input.agent),
    ...(input.agentType ? { "agent.type": input.agentType } : {}),
  }
  if (flavor === "gen_ai") {
    return {
      [GEN_AI_ATTR.operationName]: OP_CHAT,
      ...shared,
      [GEN_AI_ATTR.providerName]: provider,
      [GEN_AI_ATTR.requestModel]: input.modelID,
      [GEN_AI_ATTR.responseModel]: input.modelID,
      ...(input.turnID ? { [GEN_AI_ATTR.turnID]: input.turnID } : {}),
      ...(input.stepID ? { [GEN_AI_ATTR.stepID]: input.stepID } : {}),
      ...(input.promptText ? promptAttrs(flavor, input.promptText) : {}),
    }
  }
  return {
    [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.LLM,
    ...shared,
    [LLM_SYSTEM]: input.providerID,
    [LLM_PROVIDER]: input.providerID,
    [GEN_AI_ATTR.providerName]: provider,
    [LLM_MODEL_NAME]: input.modelID,
    ...(input.promptText ? promptAttrs(flavor, input.promptText) : {}),
  }
}

/** Usage attributes shared by completed and failed LLM requests. */
type LlmUsageInput = {
  agent: string
  agentType: string
  tokens: TokenInfo
  cost: number
  finish?: string
  durationMs: number
  ttftMs?: number
  output?: string
}

/** End attributes for a completed LLM request span. */
export type LlmResultInput = LlmUsageInput

/** End attributes for a failed LLM request span; every usage field is optional. */
export type LlmFailureInput = {
  agent: string
  agentType: string
  tokens?: TokenInfo
  cost?: number
  finish?: string
  error?: StructuredError
  durationMs: number
  ttftMs?: number
  output?: string
}

/** GenAI usage attributes; cache tokens are folded into the input total, as OpenAI reports them. */
function genAiUsageAttrs(tokens: TokenInfo): Attributes {
  return {
    [GEN_AI_ATTR.usageInputTokens]: tokens.input + tokens.cache.read + tokens.cache.write,
    [GEN_AI_ATTR.usageOutputTokens]: tokens.output + tokens.reasoning,
    [GEN_AI_ATTR.usageCacheReadInputTokens]: tokens.cache.read,
    [GEN_AI_ATTR.usageCacheCreationInputTokens]: tokens.cache.write,
  }
}

/** Time-to-first-token attributes; the metric keeps its own official name in both flavors. */
function ttftAttrs(flavor: SemconvFlavor, ttftMs: number | undefined): Attributes {
  if (ttftMs === undefined) return {}
  return flavor === "gen_ai"
    ? { [GEN_AI_ATTR.timeToFirstToken]: ttftMs / 1000 }
    : { [GEN_AI_ATTR.timeToFirstToken]: ttftMs / 1000, "llm.time_to_first_token_ms": ttftMs }
}

/** Returns the end attributes for a completed LLM request span. */
export function llmEndAttrs(flavor: SemconvFlavor, input: LlmResultInput): Attributes {
  const shared = {
    ...agentNameAttrs(flavor, input.agent),
    "agent.type": input.agentType,
    ...ttftAttrs(flavor, input.ttftMs),
    duration_ms: input.durationMs,
    ...(input.output ? outputAttrs(flavor, input.output, input.finish) : {}),
  }
  if (flavor === "gen_ai") {
    return {
      ...shared,
      ...genAiUsageAttrs(input.tokens),
      ...costAttrs(flavor, input.cost),
      ...(input.finish ? { [GEN_AI_ATTR.responseFinishReasons]: [input.finish] } : {}),
    }
  }
  return {
    ...shared,
    [LLM_TOKEN_COUNT_PROMPT]: input.tokens.input,
    [LLM_TOKEN_COUNT_COMPLETION]: input.tokens.output,
    [LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING]: input.tokens.reasoning,
    [LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ]: input.tokens.cache.read,
    [LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE]: input.tokens.cache.write,
    [LLM_TOKEN_COUNT_TOTAL]: input.tokens.input + input.tokens.output + input.tokens.reasoning + input.tokens.cache.read + input.tokens.cache.write,
    [LLM_FINISH_REASON]: input.finish,
    [LLM_COST_TOTAL]: input.cost,
    ...costAttrs(flavor, input.cost),
  }
}

/**
 * Returns the end attributes for a failed LLM request span. A structured error wins the
 * `error.type` grouping key; the finish reason is only a fallback when none was reported.
 */
export function llmFailAttrs(flavor: SemconvFlavor, input: LlmFailureInput): Attributes {
  const finishReason = input.finish ?? "error"
  const shared = {
    ...agentNameAttrs(flavor, input.agent),
    "agent.type": input.agentType,
    duration_ms: input.durationMs,
    ...ttftAttrs(flavor, input.ttftMs),
    ...errorAttrs(input.error),
    ...(input.output ? failureOutputAttrs(flavor, input.output) : {}),
  }
  if (flavor === "gen_ai") {
    return {
      ...shared,
      ...(input.error ? {} : { [GEN_AI_ATTR.errorType]: finishReason }),
      ...(input.tokens ? genAiUsageAttrs(input.tokens) : {}),
      ...(input.cost !== undefined ? costAttrs(flavor, input.cost) : {}),
    }
  }
  return {
    ...shared,
    [LLM_FINISH_REASON]: finishReason,
    ...(input.tokens ? {
      [LLM_TOKEN_COUNT_PROMPT]: input.tokens.input,
      [LLM_TOKEN_COUNT_COMPLETION]: input.tokens.output,
      [LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING]: input.tokens.reasoning,
      [LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ]: input.tokens.cache.read,
      [LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE]: input.tokens.cache.write,
      [LLM_TOKEN_COUNT_TOTAL]: input.tokens.input + input.tokens.output + input.tokens.reasoning + input.tokens.cache.read + input.tokens.cache.write,
    } : {}),
    ...(input.cost !== undefined ? { [LLM_COST_TOTAL]: input.cost, ...costAttrs(flavor, input.cost) } : {}),
  }
}

/** Start attributes for a tool execution span. */
export type ToolSpanInput = {
  sessionID: string
  tool: string
  callID: string
  agent?: string
  agentType?: string
  subagent?: string
  /** Plugin extension: inherited turn id, emitted in `gen_ai` only. */
  turnID?: string
  /** Plugin extension: inherited step id, emitted in `gen_ai` only. */
  stepID?: string
  /**
   * Plugin extension: tool call that roots this span's subtree. A subagent dispatch span
   * declares its own call id so a child run span can reference the same join key.
   */
  parentToolCallID?: string
}

/** Returns the start attributes for a tool execution span. */
export function toolStartAttrs(flavor: SemconvFlavor, input: ToolSpanInput): Attributes {
  const shared = {
    ...conversationAttrs(flavor, input.sessionID),
    ...(input.agent ? agentNameAttrs(flavor, input.agent) : {}),
    ...(input.agentType ? { "agent.type": input.agentType } : {}),
    ...(input.subagent ? { "subagent.agent": input.subagent } : {}),
    ...(input.parentToolCallID ? { "parent_tool_call_id": input.parentToolCallID } : {}),
  }
  if (flavor === "gen_ai") {
    return {
      [GEN_AI_ATTR.operationName]: OP_EXECUTE_TOOL,
      ...shared,
      [GEN_AI_ATTR.toolName]: input.tool,
      [GEN_AI_ATTR.toolCallID]: input.callID,
      [GEN_AI_ATTR.toolType]: "function",
      ...(input.turnID ? { [GEN_AI_ATTR.turnID]: input.turnID } : {}),
      ...(input.stepID ? { [GEN_AI_ATTR.stepID]: input.stepID } : {}),
    }
  }
  return {
    [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
    ...shared,
    [TOOL_ID]: input.callID,
    [TOOL_NAME]: input.tool,
  }
}

/** Largest number of paths reported for a multi-path tool call. */
const MAX_FACT_PATHS = 32
/** Largest number of characters retained for a single reported path. */
const FACT_PATH_LIMIT = 1_024

/**
 * Returns the factual attributes for a tool call: the verbatim command for shell tools and the
 * operation/paths for file tools. Facts are not content, so they are emitted regardless of
 * `captureContent`; they never carry a judgement (no risk/policy/audit keys).
 */
export function toolFactsAttrs(facts: ToolFacts | undefined): Attributes {
  if (!facts) return {}
  const attrs: Attributes = {}
  if (facts.operation) attrs["file.operation"] = facts.operation
  if (facts.paths?.length) {
    const paths = facts.paths.map((path) => truncateContent(path, FACT_PATH_LIMIT))
    const cut = paths.some((path) => path.truncated) || paths.length > MAX_FACT_PATHS
    const kept = paths.slice(0, MAX_FACT_PATHS)
    if (kept.length === 1) {
      attrs["file.path"] = kept[0]!.text
      Object.assign(attrs, truncationAttrs("file.path", kept[0]!))
    } else {
      attrs["file.paths"] = kept.map((path) => path.text)
      if (cut) {
        attrs["file.paths.truncated"] = true
        attrs["file.paths.original_count"] = facts.paths.length
      }
    }
  }
  if (facts.command) {
    const command = truncateContent(facts.command)
    attrs["tool.command"] = command.text
    Object.assign(attrs, truncationAttrs("tool.command", command))
  }
  return attrs
}

/** Attributes added when the tool input is known. */
export type ToolCallInput = {
  agent: string
  agentType: string
  inputJson?: string
  providerExecuted: boolean
  facts?: ToolFacts
}

/** Returns the attributes added once the tool input is known. */
export function toolCallAttrs(flavor: SemconvFlavor, input: ToolCallInput): Attributes {
  const args = truncateContent(input.inputJson)
  const shared = {
    ...agentNameAttrs(flavor, input.agent),
    "agent.type": input.agentType,
    "tool.provider_executed": input.providerExecuted,
    ...toolFactsAttrs(input.facts),
    ...truncationAttrs("tool.arguments", args),
  }
  if (!args.text) return shared
  return flavor === "gen_ai"
    ? { ...shared, [GEN_AI_ATTR.toolCallArguments]: args.text }
    : { ...shared, [TOOL_PARAMETERS]: args.text, [INPUT_VALUE]: args.text, [INPUT_MIME_TYPE]: MimeType.JSON }
}

/** Attributes added when the tool completes. */
export type ToolResultInput = {
  agent: string
  agentType: string
  success: boolean
  output?: string
  error?: StructuredError
  sizeBytes?: number
}

/** Returns the attributes added when the tool completes. */
export function toolEndAttrs(flavor: SemconvFlavor, input: ToolResultInput): Attributes {
  const output = truncateContent(input.output)
  const shared = {
    ...agentNameAttrs(flavor, input.agent),
    "agent.type": input.agentType,
    "tool.success": input.success,
    ...(input.success
      ? { "tool.result_size_bytes": input.sizeBytes ?? 0 }
      : { "tool.error": errorSummary(input.error), ...errorAttrs(input.error) }),
    ...truncationAttrs("tool.result", output),
  }
  if (flavor === "gen_ai") {
    return { ...shared, ...(output.text ? { [GEN_AI_ATTR.toolCallResult]: output.text } : {}) }
  }
  return { ...shared, ...(output.text ? { [OUTPUT_VALUE]: output.text, [OUTPUT_MIME_TYPE]: MimeType.TEXT } : {}) }
}
