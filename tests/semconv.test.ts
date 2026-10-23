import { describe, test, expect } from "bun:test"
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_GEN_AI_TOKEN_TYPE,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  METRIC_GEN_AI_CLIENT_OPERATION_DURATION,
  METRIC_GEN_AI_CLIENT_TOKEN_USAGE,
  METRIC_GEN_AI_SERVER_TIME_TO_FIRST_TOKEN,
} from "@opentelemetry/semantic-conventions/incubating"
import {
  agentEndAttrs,
  agentSpanName,
  agentStartAttrs,
  DEFAULT_SEMCONV,
  GEN_AI_ATTR,
  GEN_AI_METRIC,
  inputMessageAttrs,
  isEventSuppressed,
  llmEndAttrs,
  llmFailAttrs,
  llmSpanName,
  llmStartAttrs,
  parseSemconv,
  promptAttrs,
  signalAttrs,
  toolCallAttrs,
  toolEndAttrs,
  toolSpanName,
  toolStartAttrs,
} from "../src/semconv.ts"
import { tokens } from "./helpers.ts"

const GEN_AI_KEYS = {
  operationName: ATTR_GEN_AI_OPERATION_NAME,
  providerName: ATTR_GEN_AI_PROVIDER_NAME,
  requestModel: ATTR_GEN_AI_REQUEST_MODEL,
  responseModel: ATTR_GEN_AI_RESPONSE_MODEL,
  responseFinishReasons: ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  conversationID: ATTR_GEN_AI_CONVERSATION_ID,
  agentName: ATTR_GEN_AI_AGENT_NAME,
  inputMessages: ATTR_GEN_AI_INPUT_MESSAGES,
  outputMessages: ATTR_GEN_AI_OUTPUT_MESSAGES,
  usageInputTokens: ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  usageOutputTokens: ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  usageCacheReadInputTokens: ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  usageCacheCreationInputTokens: ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  toolName: ATTR_GEN_AI_TOOL_NAME,
  toolCallID: ATTR_GEN_AI_TOOL_CALL_ID,
  toolCallArguments: ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  toolCallResult: ATTR_GEN_AI_TOOL_CALL_RESULT,
  toolType: ATTR_GEN_AI_TOOL_TYPE,
}

describe("parseSemconv", () => {
  test("accepts the documented values and common spellings", () => {
    expect(parseSemconv("openinference")).toBe("openinference")
    expect(parseSemconv("gen_ai")).toBe("gen_ai")
    expect(parseSemconv("GEN-AI")).toBe("gen_ai")
    expect(parseSemconv(" genai ")).toBe("gen_ai")
  })

  test("returns undefined for unset or unknown values so the caller can warn", () => {
    expect(parseSemconv(undefined)).toBeUndefined()
    expect(parseSemconv("")).toBeUndefined()
    expect(parseSemconv("opentelemetry")).toBeUndefined()
  })

  test("defaults to openinference", () => {
    expect(DEFAULT_SEMCONV).toBe("openinference")
  })
})

describe("gen_ai attribute keys", () => {
  test("every key matches the official OpenTelemetry semantic conventions", () => {
    expect(GEN_AI_ATTR).toMatchObject(GEN_AI_KEYS)
    expect(GEN_AI_ATTR.timeToFirstToken).toBe(METRIC_GEN_AI_SERVER_TIME_TO_FIRST_TOKEN)
    expect(GEN_AI_ATTR.errorType).toBe("error.type")
  })
})

describe("span names", () => {
  test("gen_ai uses the operation-qualified names from the specification", () => {
    expect(agentSpanName("gen_ai", "build", "opencode.")).toBe("invoke_agent build")
    expect(llmSpanName("gen_ai", "claude-sonnet", "opencode.")).toBe("chat claude-sonnet")
    expect(toolSpanName("gen_ai", "read", "opencode.")).toBe("execute_tool read")
  })

  test("openinference keeps the prefixed names existing dashboards rely on", () => {
    expect(agentSpanName("openinference", "build", "opencode.")).toBe("opencode.session")
    expect(llmSpanName("openinference", "claude-sonnet", "opencode.")).toBe("opencode.llm")
    expect(toolSpanName("openinference", "read", "opencode.")).toBe("opencode.tool.read")
  })
})

describe("message serialization", () => {
  test("gen_ai nests text parts under a role, as the specification requires", () => {
    expect(inputMessageAttrs("gen_ai", [{ role: "user", content: "hi" }])).toEqual({
      "gen_ai.input.messages": JSON.stringify([{ role: "user", parts: [{ type: "text", content: "hi" }] }]),
    })
  })

  test("openinference keeps the flat role/content shape", () => {
    expect(inputMessageAttrs("openinference", [{ role: "user", content: "hi" }])).toEqual({
      "llm.input_messages": JSON.stringify([{ role: "user", content: "hi" }]),
    })
  })

  test("a prompt carries mime type metadata in openinference but not in gen_ai", () => {
    expect(promptAttrs("openinference", "hi")).toMatchObject({ "input.value": "hi", "input.mime_type": "text/plain" })
    expect(promptAttrs("gen_ai", "hi")).not.toHaveProperty("input.value")
  })
})

describe("LLM span attributes", () => {
  const start = {
    sessionID: "ses_1",
    agent: "build",
    agentType: "primary",
    providerID: "amazon-bedrock",
    modelID: "claude-sonnet",
    promptText: "hello",
  }

  test("gen_ai start attributes describe the chat operation without OpenInference keys", () => {
    const attrs = llmStartAttrs("gen_ai", start)
    expect(attrs["gen_ai.operation.name"]).toBe("chat")
    expect(attrs["gen_ai.provider.name"]).toBe("aws.bedrock")
    expect(attrs["gen_ai.request.model"]).toBe("claude-sonnet")
    expect(attrs["gen_ai.response.model"]).toBe("claude-sonnet")
    expect(attrs["gen_ai.conversation.id"]).toBe("ses_1")
    expect(attrs["gen_ai.agent.name"]).toBe("build")
    expect(attrs["gen_ai.input.messages"]).toBe(JSON.stringify([{ role: "user", parts: [{ type: "text", content: "hello" }] }]))
    expect(Object.keys(attrs).some((key) => key.startsWith("llm.") || key === "openinference.span.kind")).toBe(false)
  })

  test("openinference start attributes are unchanged", () => {
    const attrs = llmStartAttrs("openinference", start)
    expect(attrs["openinference.span.kind"]).toBe("LLM")
    expect(attrs["llm.model_name"]).toBe("claude-sonnet")
    expect(attrs["llm.provider"]).toBe("amazon-bedrock")
    expect(attrs["gen_ai.provider.name"]).toBe("aws.bedrock")
    expect(attrs["llm.input_messages"]).toBe('[{"role":"user","content":"hello"}]')
    expect(attrs["gen_ai.operation.name"]).toBeUndefined()
  })

  test("gen_ai usage folds cache tokens into input and reasoning into output", () => {
    const attrs = llmEndAttrs("gen_ai", {
      agent: "build",
      agentType: "primary",
      tokens: tokens(10, 5, 2, 3, 4),
      cost: 0.25,
      finish: "stop",
      durationMs: 1200,
      ttftMs: 400,
      output: "done",
    })
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(17)
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(7)
    expect(attrs["gen_ai.usage.cache_read.input_tokens"]).toBe(3)
    expect(attrs["gen_ai.usage.cache_creation.input_tokens"]).toBe(4)
    expect(attrs["gen_ai.response.finish_reasons"]).toEqual(["stop"])
    expect(attrs["gen_ai.server.time_to_first_token"]).toBe(0.4)
    expect(attrs["gen_ai.output.messages"]).toBe(JSON.stringify([{ role: "assistant", parts: [{ type: "text", content: "done" }], finish_reason: "stop" }]))
    expect(attrs["llm.token_count.total"]).toBeUndefined()
  })

  test("openinference usage keeps the per-bucket token counts", () => {
    const attrs = llmEndAttrs("openinference", {
      agent: "build",
      agentType: "primary",
      tokens: tokens(10, 5, 2, 3, 4),
      cost: 0.25,
      finish: "stop",
      durationMs: 1200,
      ttftMs: 400,
      output: "done",
    })
    expect(attrs["llm.token_count.prompt"]).toBe(10)
    expect(attrs["llm.token_count.completion"]).toBe(5)
    expect(attrs["llm.token_count.total"]).toBe(24)
    expect(attrs["llm.finish_reason"]).toBe("stop")
    expect(attrs["llm.output_messages"]).toBe('[{"role":"assistant","content":"done"}]')
    expect(attrs["llm.time_to_first_token_ms"]).toBe(400)
    expect(attrs["gen_ai.usage.input_tokens"]).toBeUndefined()
  })

  test("a failed request reports error.type and keeps partial usage", () => {
    const genAi = llmFailAttrs("gen_ai", { agent: "build", agentType: "primary", tokens: tokens(10, 5), durationMs: 100 })
    expect(genAi["error.type"]).toBe("error")
    expect(genAi["gen_ai.usage.input_tokens"]).toBe(10)
    expect(genAi["gen_ai.response.finish_reasons"]).toBeUndefined()

    const openinference = llmFailAttrs("openinference", { agent: "build", agentType: "primary", tokens: tokens(10, 5), durationMs: 100 })
    expect(openinference["llm.finish_reason"]).toBe("error")
    expect(openinference["llm.output_messages"]).toBeUndefined()
  })
})

describe("agent span attributes", () => {
  test("gen_ai run spans use invoke_agent and the conversation id", () => {
    const attrs = agentStartAttrs("gen_ai", { sessionID: "ses_1", agent: "build", agentType: "primary", isSubagent: false, promptText: "hi" })
    expect(attrs["gen_ai.operation.name"]).toBe("invoke_agent")
    expect(attrs["gen_ai.conversation.id"]).toBe("ses_1")
    expect(attrs["gen_ai.agent.name"]).toBe("build")
    expect(attrs["gen_ai.input.messages"]).toBe(JSON.stringify([{ role: "user", parts: [{ type: "text", content: "hi" }] }]))
    expect(attrs["openinference.span.kind"]).toBeUndefined()
  })

  test("openinference run spans keep the agent kind", () => {
    const attrs = agentStartAttrs("openinference", { sessionID: "ses_1", agent: "build", agentType: "primary", isSubagent: false })
    expect(attrs["openinference.span.kind"]).toBe("AGENT")
    expect(attrs["session.id"]).toBe("ses_1")
  })

  test("totals are attached in both flavors", () => {
    const totals = { agent: "build", agentType: "primary", tokens: 100, cost: 0.5, messages: 3 }
    for (const flavor of ["openinference", "gen_ai"] as const) {
      const attrs = agentEndAttrs(flavor, totals)
      expect(attrs["session.total_tokens"]).toBe(100)
      expect(attrs["session.total_cost_usd"]).toBe(0.5)
      expect(attrs["session.total_messages"]).toBe(3)
    }
  })
})

describe("tool span attributes", () => {
  test("gen_ai tool spans describe the execute_tool operation", () => {
    const start = toolStartAttrs("gen_ai", { sessionID: "ses_1", tool: "read", callID: "call_1" })
    expect(start["gen_ai.operation.name"]).toBe("execute_tool")
    expect(start["gen_ai.tool.name"]).toBe("read")
    expect(start["gen_ai.tool.call.id"]).toBe("call_1")
    expect(start["gen_ai.tool.type"]).toBe("function")
    expect(start["openinference.span.kind"]).toBeUndefined()

    const call = toolCallAttrs("gen_ai", { agent: "build", agentType: "primary", inputJson: '{"path":"a"}', providerExecuted: false })
    expect(call["gen_ai.tool.call.arguments"]).toBe('{"path":"a"}')
    expect(call["tool.parameters"]).toBeUndefined()

    const end = toolEndAttrs("gen_ai", { agent: "build", agentType: "primary", success: true, output: "ok", sizeBytes: 2 })
    expect(end["gen_ai.tool.call.result"]).toBe("ok")
    expect(end["tool.success"]).toBe(true)
  })

  test("a subagent dispatch keeps its target agent", () => {
    const attrs = toolStartAttrs("gen_ai", { sessionID: "ses_1", tool: "subagent", callID: "call_1", agent: "build", agentType: "primary", subagent: "explore" })
    expect(attrs["subagent.agent"]).toBe("explore")
    expect(attrs["gen_ai.agent.name"]).toBe("build")
  })

  test("a failed tool records the error instead of a result size", () => {
    const end = toolEndAttrs("openinference", { agent: "build", agentType: "primary", success: false, error: "boom", sizeBytes: 9 })
    expect(end["tool.error"]).toBe("boom")
    expect(end["tool.result_size_bytes"]).toBeUndefined()
    expect(end["output.value"]).toBeUndefined()
  })
})

describe("metric names", () => {
  test("match the official GenAI metric constants", () => {
    expect(GEN_AI_METRIC.tokenUsage).toBe(METRIC_GEN_AI_CLIENT_TOKEN_USAGE)
    expect(GEN_AI_METRIC.operationDuration).toBe(METRIC_GEN_AI_CLIENT_OPERATION_DURATION)
    expect(GEN_AI_METRIC.timeToFirstToken).toBe(METRIC_GEN_AI_SERVER_TIME_TO_FIRST_TOKEN)
  })

  test("are never prefixed", () => {
    for (const name of Object.values(GEN_AI_METRIC)) expect(name.startsWith("gen_ai.")).toBe(true)
  })

  test("the token-type attribute matches the convention", () => {
    expect(GEN_AI_ATTR.usageInputTokens).toBe(ATTR_GEN_AI_USAGE_INPUT_TOKENS)
    expect(GEN_AI_ATTR.usageOutputTokens).toBe(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS)
    expect(ATTR_GEN_AI_TOKEN_TYPE).toBe("gen_ai.token.type")
  })
})

describe("signal attributes", () => {
  const identity = { sessionID: "ses_1", agent: "build", agentType: "primary", modelID: "claude-sonnet", providerID: "anthropic", tool: "read" }

  test("openinference keeps the OpenInference names", () => {
    const attrs = signalAttrs("openinference", identity)
    expect(attrs["session.id"]).toBe("ses_1")
    expect(attrs["tool_name"]).toBe("read")
    expect(attrs["model"]).toBe("claude-sonnet")
    expect(attrs["provider"]).toBe("anthropic")
    expect(attrs["agent"]).toBe("build")
    expect(attrs["gen_ai.conversation.id"]).toBeUndefined()
  })

  test("gen_ai swaps every key but the join key", () => {
    const attrs = signalAttrs("gen_ai", identity)
    expect(attrs["session.id"]).toBe("ses_1")
    expect(attrs["gen_ai.conversation.id"]).toBe("ses_1")
    expect(attrs["gen_ai.tool.name"]).toBe("read")
    expect(attrs["gen_ai.request.model"]).toBe("claude-sonnet")
    expect(attrs["gen_ai.provider.name"]).toBe("anthropic")
    expect(attrs["gen_ai.agent.name"]).toBe("build")
    expect(attrs["tool_name"]).toBeUndefined()
    expect(attrs["model"]).toBeUndefined()
    expect(attrs["provider"]).toBeUndefined()
    expect(attrs["agent"]).toBeUndefined()
  })

  test("omits absent identity fields", () => {
    expect(Object.keys(signalAttrs("gen_ai", {}))).toEqual([])
  })
})

describe("redundant log events", () => {
  test("are suppressed only in the gen_ai flavor", () => {
    for (const name of ["api_request", "api_error", "tool_result", "session.created"]) {
      expect(isEventSuppressed("gen_ai", name)).toBe(true)
      expect(isEventSuppressed("openinference", name)).toBe(false)
    }
  })

  test("keep every event that a span does not already carry", () => {
    for (const name of ["user_prompt", "session.idle", "session.error", "tool_decision", "commit", "subtask_invoked"]) {
      expect(isEventSuppressed("gen_ai", name)).toBe(false)
    }
  })
})

describe("tool content capture", () => {
  test("gen_ai returns identity only when the input is not captured", () => {
    const attrs = toolCallAttrs("gen_ai", { agent: "build", agentType: "primary", providerExecuted: false })
    expect(attrs["gen_ai.tool.call.arguments"]).toBeUndefined()
    expect(attrs["gen_ai.agent.name"]).toBe("build")
    expect(attrs["tool.provider_executed"]).toBe(false)
  })

  test("openinference returns identity only when the input is not captured", () => {
    const attrs = toolCallAttrs("openinference", { agent: "build", agentType: "primary", providerExecuted: true })
    expect(attrs["tool.parameters"]).toBeUndefined()
    expect(attrs["input.value"]).toBeUndefined()
    expect(attrs["tool.provider_executed"]).toBe(true)
  })
})
