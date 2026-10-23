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
import type { MessageEntry } from "./types.ts"
import { genAiProviderName, type TokenInfo } from "./util.ts"

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
 * flavor. Written as literals for readability; `tests/semconv.test.ts` asserts every entry
 * against `@opentelemetry/semantic-conventions/incubating` so drift fails the build.
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
  timeToFirstToken: "gen_ai.server.time_to_first_token",
  toolName: "gen_ai.tool.name",
  toolCallID: "gen_ai.tool.call.id",
  toolCallArguments: "gen_ai.tool.call.arguments",
  toolCallResult: "gen_ai.tool.call.result",
  toolType: "gen_ai.tool.type",
  errorType: "error.type",
} as const

/** `gen_ai.operation.name` values used by this plugin. */
const OP_CHAT = "chat"
const OP_EXECUTE_TOOL = "execute_tool"
const OP_INVOKE_AGENT = "invoke_agent"

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
 */
export function inputMessageAttrs(flavor: SemconvFlavor, entries: readonly MessageEntry[]): Attributes {
  if (flavor === "gen_ai") {
    return {
      [GEN_AI_ATTR.inputMessages]: JSON.stringify(entries.map((entry) => ({
        role: entry.role,
        parts: [{ type: "text", content: entry.content }],
      }))),
    }
  }
  return { [LLM_INPUT_MESSAGES]: JSON.stringify(entries) }
}

/** Attributes for a single observed user prompt. */
export function promptAttrs(flavor: SemconvFlavor, text: string): Attributes {
  if (flavor === "gen_ai") return inputMessageAttrs(flavor, [{ role: "user", content: text }])
  return {
    [INPUT_VALUE]: text,
    [INPUT_MIME_TYPE]: MimeType.TEXT,
    [LLM_INPUT_MESSAGES]: JSON.stringify([{ role: "user", content: text }]),
  }
}

/** Attributes for the assistant output of a completed or failed LLM request. */
export function outputAttrs(flavor: SemconvFlavor, text: string, finishReason?: string): Attributes {
  if (flavor === "gen_ai") {
    return {
      [GEN_AI_ATTR.outputMessages]: JSON.stringify([{
        role: "assistant",
        parts: [{ type: "text", content: text }],
        ...(finishReason ? { finish_reason: finishReason } : {}),
      }]),
    }
  }
  return {
    [OUTPUT_VALUE]: text,
    [OUTPUT_MIME_TYPE]: MimeType.TEXT,
    [LLM_OUTPUT_MESSAGES]: JSON.stringify([{ role: "assistant", content: text }]),
  }
}

/** Attributes for partial assistant output on a failed request; no finish reason is known. */
function failureOutputAttrs(flavor: SemconvFlavor, text: string): Attributes {
  if (flavor === "gen_ai") {
    return { [GEN_AI_ATTR.outputMessages]: JSON.stringify([{ role: "assistant", parts: [{ type: "text", content: text }] }]) }
  }
  return { [OUTPUT_VALUE]: text, [OUTPUT_MIME_TYPE]: MimeType.TEXT }
}

/** Start attributes for a run (agent) span. */
export type AgentSpanInput = {
  sessionID: string
  agent: string
  agentType: string
  isSubagent: boolean
  promptText?: string
}

/** Returns the start attributes for a run (agent) span. */
export function agentStartAttrs(flavor: SemconvFlavor, input: AgentSpanInput): Attributes {
  const shared = {
    ...conversationAttrs(flavor, input.sessionID),
    ...agentNameAttrs(flavor, input.agent),
    "agent.type": input.agentType,
    "session.is_subagent": input.isSubagent,
  }
  return {
    ...(flavor === "gen_ai" ? { [GEN_AI_ATTR.operationName]: OP_INVOKE_AGENT } : { [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT }),
    ...shared,
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
    cost_usd: input.cost,
    duration_ms: input.durationMs,
    ...(input.output ? outputAttrs(flavor, input.output, input.finish) : {}),
  }
  if (flavor === "gen_ai") {
    return {
      ...shared,
      ...genAiUsageAttrs(input.tokens),
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
  }
}

/** Returns the end attributes for a failed LLM request span. */
export function llmFailAttrs(flavor: SemconvFlavor, input: LlmFailureInput): Attributes {
  const finishReason = input.finish ?? "error"
  const shared = {
    ...agentNameAttrs(flavor, input.agent),
    "agent.type": input.agentType,
    duration_ms: input.durationMs,
    ...ttftAttrs(flavor, input.ttftMs),
    ...(input.output ? failureOutputAttrs(flavor, input.output) : {}),
  }
  if (flavor === "gen_ai") {
    return {
      ...shared,
      [GEN_AI_ATTR.errorType]: finishReason,
      ...(input.tokens ? genAiUsageAttrs(input.tokens) : {}),
      ...(input.cost !== undefined ? { cost_usd: input.cost } : {}),
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
    ...(input.cost !== undefined ? { [LLM_COST_TOTAL]: input.cost, cost_usd: input.cost } : {}),
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
}

/** Returns the start attributes for a tool execution span. */
export function toolStartAttrs(flavor: SemconvFlavor, input: ToolSpanInput): Attributes {
  const shared = {
    ...conversationAttrs(flavor, input.sessionID),
    ...(input.agent ? agentNameAttrs(flavor, input.agent) : {}),
    ...(input.agentType ? { "agent.type": input.agentType } : {}),
    ...(input.subagent ? { "subagent.agent": input.subagent } : {}),
  }
  if (flavor === "gen_ai") {
    return {
      [GEN_AI_ATTR.operationName]: OP_EXECUTE_TOOL,
      ...shared,
      [GEN_AI_ATTR.toolName]: input.tool,
      [GEN_AI_ATTR.toolCallID]: input.callID,
      [GEN_AI_ATTR.toolType]: "function",
    }
  }
  return {
    [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
    ...shared,
    [TOOL_ID]: input.callID,
    [TOOL_NAME]: input.tool,
  }
}

/** Attributes added when the tool input is known. */
export type ToolCallInput = {
  agent: string
  agentType: string
  inputJson: string
  providerExecuted: boolean
}

/** Returns the attributes added once the tool input is known. */
export function toolCallAttrs(flavor: SemconvFlavor, input: ToolCallInput): Attributes {
  const shared = {
    ...agentNameAttrs(flavor, input.agent),
    "agent.type": input.agentType,
    "tool.provider_executed": input.providerExecuted,
  }
  return flavor === "gen_ai"
    ? { ...shared, [GEN_AI_ATTR.toolCallArguments]: input.inputJson }
    : { ...shared, [TOOL_PARAMETERS]: input.inputJson, [INPUT_VALUE]: input.inputJson, [INPUT_MIME_TYPE]: MimeType.JSON }
}

/** Attributes added when the tool completes. */
export type ToolResultInput = {
  agent: string
  agentType: string
  success: boolean
  output?: string
  error?: string
  sizeBytes?: number
}

/** Returns the attributes added when the tool completes. */
export function toolEndAttrs(flavor: SemconvFlavor, input: ToolResultInput): Attributes {
  const shared = {
    ...agentNameAttrs(flavor, input.agent),
    "agent.type": input.agentType,
    "tool.success": input.success,
    ...(input.success
      ? { "tool.result_size_bytes": input.sizeBytes ?? 0 }
      : { "tool.error": input.error ?? "unknown" }),
  }
  if (flavor === "gen_ai") {
    return { ...shared, ...(input.output ? { [GEN_AI_ATTR.toolCallResult]: input.output } : {}) }
  }
  return { ...shared, ...(input.output ? { [OUTPUT_VALUE]: input.output, [OUTPUT_MIME_TYPE]: MimeType.TEXT } : {}) }
}
