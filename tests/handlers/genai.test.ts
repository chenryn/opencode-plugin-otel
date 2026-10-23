import { describe, test, expect } from "bun:test"
import { SpanStatusCode } from "@opentelemetry/api"
import {
  handleExecutionEnded,
  handleExecutionStarted,
  handlePromptEnqueued,
  handleSessionCreated,
} from "../../src/handlers/session.ts"
import { handleStepEnded, handleStepFailed, handleStepStarted, handleTextEnded, handleTextStarted } from "../../src/handlers/step.ts"
import { handleToolCalled, handleToolInputStarted, handleToolSuccess } from "../../src/handlers/tool.ts"
import { makeCtx, evt, tokens } from "../helpers.ts"

function genAiCtx() {
  return makeCtx("proj_test", [], [], true, {}, "gen_ai")
}

/** A `gen_ai` context with content capture off, matching the plugin's default wiring. */
function gatedCtx() {
  return makeCtx("proj_test", [], [], true, {}, "gen_ai", false)
}

const OPENINFERENCE_KEYS = ["openinference.span.kind", "input.value", "input.mime_type", "output.value", "output.mime_type", "tool.id", "tool.name", "tool.parameters"]

function assertNoOpenInferenceAttrs(span: { attributes: Record<string, unknown> }) {
  const leaked = Object.keys(span.attributes).filter((key) => key.startsWith("llm.") || OPENINFERENCE_KEYS.includes(key))
  expect(leaked).toEqual([])
}

function seedRun(ctx: ReturnType<typeof genAiCtx>["ctx"]) {
  handleSessionCreated(evt("session.created", { sessionID: "ses_1", agent: "build", projectID: "proj_test" }), ctx)
  handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }, 1000), ctx)
}

function startStep(ctx: ReturnType<typeof genAiCtx>["ctx"], started = 1500) {
  handleStepStarted(
    evt("session.step.started", {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      agent: "build",
      model: { id: "claude-sonnet", providerID: "anthropic" },
      started,
    }, started),
    ctx,
  )
}

describe("gen_ai flavor end to end", () => {
  test("emits operation-qualified spans with no OpenInference attributes", () => {
    const { ctx, tracer } = genAiCtx()
    seedRun(ctx)
    startStep(ctx)
    handleTextStarted(evt("session.text.started", { sessionID: "ses_1", assistantMessageID: "msg_1" }, 1900), ctx)
    handleTextEnded(evt("session.text.ended", { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, text: "hello" }), ctx)
    handleStepEnded(
      evt("session.step.ended", { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "stop", cost: 0.25, tokens: tokens(10, 5, 2, 3, 4) }, 2600),
      ctx,
    )
    handleExecutionEnded(evt("session.execution.succeeded", { sessionID: "ses_1" }, 3000), ctx, { type: "succeeded" })

    expect(tracer.spans.map((span) => span.name)).toEqual(["invoke_agent build", "chat claude-sonnet"])
    for (const span of tracer.spans) assertNoOpenInferenceAttrs(span)

    const llm = tracer.spans.find((span) => span.name === "chat claude-sonnet")!
    expect(llm.attributes["gen_ai.operation.name"]).toBe("chat")
    expect(llm.attributes["gen_ai.provider.name"]).toBe("anthropic")
    expect(llm.attributes["gen_ai.request.model"]).toBe("claude-sonnet")
    expect(llm.attributes["gen_ai.usage.input_tokens"]).toBe(17)
    expect(llm.attributes["gen_ai.usage.output_tokens"]).toBe(7)
    expect(llm.attributes["gen_ai.response.finish_reasons"]).toEqual(["stop"])
    expect(llm.attributes["gen_ai.server.time_to_first_token"]).toBe(0.4)
    expect(llm.attributes["gen_ai.output.messages"]).toBe('[{"role":"assistant","parts":[{"type":"text","content":"hello"}],"finish_reason":"stop"}]')
    expect(llm.status.code).toBe(SpanStatusCode.OK)

    const run = tracer.spans.find((span) => span.name === "invoke_agent build")!
    expect(run.attributes["gen_ai.operation.name"]).toBe("invoke_agent")
    expect(run.attributes["gen_ai.conversation.id"]).toBe("ses_1")
    expect(run.attributes["session.total_tokens"]).toBe(24)
  })

  test("emits execute_tool spans carrying arguments and results", () => {
    const { ctx, tracer } = genAiCtx()
    seedRun(ctx)
    startStep(ctx)
    handleToolInputStarted(evt("session.tool.input.started", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", name: "read" }, 1600), ctx)
    handleToolCalled(evt("session.tool.called", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", input: { path: "a.ts" }, executed: false }, 1700), ctx)
    handleToolSuccess(evt("session.tool.success", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", content: [{ type: "text", text: "file body" }], executed: false }, 2100), ctx)

    const tool = tracer.spans.find((span) => span.name === "execute_tool read")!
    expect(tool.attributes["gen_ai.operation.name"]).toBe("execute_tool")
    expect(tool.attributes["gen_ai.tool.name"]).toBe("read")
    expect(tool.attributes["gen_ai.tool.call.id"]).toBe("call_1")
    expect(tool.attributes["gen_ai.tool.type"]).toBe("function")
    expect(tool.attributes["gen_ai.tool.call.arguments"]).toBe('{"path":"a.ts"}')
    expect(tool.attributes["gen_ai.tool.call.result"]).toBe("file body")
    expect(tool.attributes["gen_ai.agent.name"]).toBe("build")
    assertNoOpenInferenceAttrs(tool)
  })

  test("reports a failed step through error.type", () => {
    const { ctx, tracer } = genAiCtx()
    seedRun(ctx)
    startStep(ctx)
    handleStepFailed(
      evt("session.step.failed", { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "content_filter", tokens: tokens(10, 5), error: { type: "api", message: "boom" } }, 2000),
      ctx,
    )
    const llm = tracer.spans.find((span) => span.name === "chat claude-sonnet")!
    expect(llm.attributes["error.type"]).toBe("content_filter")
    expect(llm.status.code).toBe(SpanStatusCode.ERROR)
    assertNoOpenInferenceAttrs(llm)
  })

  test("renames the run span once a late agent resolution lands", () => {
    const { ctx, tracer } = genAiCtx()
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }, 1000), ctx)
    const run = tracer.spans.find((span) => span.name === "invoke_agent unknown")!
    expect(run).toBeDefined()
    startStep(ctx)
    handleExecutionEnded(evt("session.execution.succeeded", { sessionID: "ses_1" }, 3000), ctx, { type: "succeeded" })
    expect(run.name).toBe("invoke_agent build")
    expect(run.attributes["gen_ai.agent.name"]).toBe("build")
  })

  test("keeps the openinference flavor as the default", () => {
    const { ctx, tracer } = makeCtx()
    seedRun(ctx)
    startStep(ctx)
    const llm = tracer.spans.find((span) => span.name === "opencode.llm")!
    expect(llm.attributes["openinference.span.kind"]).toBe("LLM")
    expect(llm.attributes["gen_ai.operation.name"]).toBeUndefined()
  })
})

describe("gen_ai metrics and log events", () => {
  test("records the official GenAI histograms and skips the OpenInference token counter", () => {
    const { ctx, counters, histograms } = genAiCtx()
    seedRun(ctx)
    startStep(ctx, 1500)
    handleStepEnded(
      evt("session.step.ended", { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "stop", cost: 0.25, tokens: tokens(10, 5, 2, 3, 4) }, 2600),
      ctx,
    )

    expect(counters.token.calls).toHaveLength(0)
    const [input, output] = histograms.tokenUsage.calls
    expect(input!.value).toBe(17)
    expect(input!.attrs["gen_ai.token.type"]).toBe("input")
    expect(input!.attrs["gen_ai.operation.name"]).toBe("chat")
    expect(input!.attrs["gen_ai.request.model"]).toBe("claude-sonnet")
    expect(input!.attrs["gen_ai.conversation.id"]).toBe("ses_1")
    expect(output!.value).toBe(7)
    expect(output!.attrs["gen_ai.token.type"]).toBe("output")

    const duration = histograms.operationDuration.calls.at(-1)!
    expect(duration.value).toBe(1.1)
    expect(duration.attrs["gen_ai.operation.name"]).toBe("chat")
    expect(duration.attrs["error.type"]).toBeUndefined()
  })

  test("tags a failed operation duration with error.type", () => {
    const { ctx, histograms } = genAiCtx()
    seedRun(ctx)
    startStep(ctx, 1500)
    handleStepFailed(
      evt("session.step.failed", { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "content_filter", error: { type: "api", message: "boom" } }, 2500),
      ctx,
    )
    expect(histograms.operationDuration.calls.at(-1)!.attrs["error.type"]).toBe("content_filter")
    expect(histograms.tokenUsage.calls).toHaveLength(0)
  })

  test("leaves the OpenInference counters alone in the default flavor", () => {
    const { ctx, counters, histograms } = makeCtx()
    seedRun(ctx)
    startStep(ctx, 1500)
    handleStepEnded(evt("session.step.ended", { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "stop", cost: 0, tokens: tokens(10, 5) }, 2600), ctx)
    expect(counters.token.calls.length).toBeGreaterThan(0)
    expect(histograms.tokenUsage.calls).toHaveLength(0)
    expect(histograms.operationDuration.calls).toHaveLength(0)
  })

  test("drops the log events that duplicate a span", () => {
    const { ctx, logger } = genAiCtx()
    seedRun(ctx)
    startStep(ctx, 1500)
    handleToolInputStarted(evt("session.tool.input.started", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", name: "read" }, 1600), ctx)
    handleToolCalled(evt("session.tool.called", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", input: { path: "a.ts" }, executed: false }, 1700), ctx)
    handleToolSuccess(evt("session.tool.success", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", content: [{ type: "text", text: "file body" }], executed: false }, 2100), ctx)
    handleStepEnded(evt("session.step.ended", { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "stop", cost: 0, tokens: tokens() }, 2600), ctx)

    const names = logger.records.map((record) => record.attributes?.["event.name"])
    expect(names).not.toContain("session.created")
    expect(names).not.toContain("api_request")
    expect(names).not.toContain("tool_result")
  })

  test("keeps the same log events in the OpenInference flavor", () => {
    const { ctx, logger } = makeCtx()
    seedRun(ctx)
    startStep(ctx, 1500)
    handleStepEnded(evt("session.step.ended", { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "stop", cost: 0, tokens: tokens() }, 2600), ctx)
    const names = logger.records.map((record) => record.attributes?.["event.name"])
    expect(names).toContain("session.created")
    expect(names).toContain("api_request")
  })
})

describe("gen_ai content capture", () => {
  function runTurn(ctx: ReturnType<typeof genAiCtx>["ctx"]) {
    handlePromptEnqueued(evt("session.inbox.enqueued", {
      sessionID: "ses_1",
      inboxID: "msg_0",
      item: { type: "user", payload: { text: "secret prompt", files: [], agents: [], skills: [] }, delivery: "queue" },
    }), ctx, true)
    seedRun(ctx)
    startStep(ctx, 1500)
    handleToolInputStarted(evt("session.tool.input.started", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", name: "read" }, 1600), ctx)
    handleToolCalled(evt("session.tool.called", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", input: { path: "a.ts" }, executed: false }, 1700), ctx)
    handleToolSuccess(evt("session.tool.success", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", content: [{ type: "text", text: "file body" }], executed: false }, 2100), ctx)
    handleTextStarted(evt("session.text.started", { sessionID: "ses_1", assistantMessageID: "msg_1" }, 2200), ctx)
    handleTextEnded(evt("session.text.ended", { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, text: "answer" }), ctx)
    handleStepEnded(evt("session.step.ended", { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "stop", cost: 0, tokens: tokens() }, 2600), ctx)
  }

  const CONTENT_KEYS = [
    "gen_ai.input.messages",
    "gen_ai.output.messages",
    "gen_ai.tool.call.arguments",
    "gen_ai.tool.call.result",
  ]

  test("omits every content attribute when capture is off", () => {
    const { ctx, tracer, logger } = gatedCtx()
    runTurn(ctx)
    expect(tracer.spans.length).toBeGreaterThan(0)
    for (const span of tracer.spans) {
      for (const key of CONTENT_KEYS) expect(span.attributes[key]).toBeUndefined()
    }
    const prompt = logger.records.find((record) => record.attributes?.["event.name"] === "user_prompt")!
    expect(prompt.attributes?.["prompt"]).toBeUndefined()
  })

  test("emits them when capture is on", () => {
    const { ctx, tracer } = genAiCtx()
    runTurn(ctx)
    const llm = tracer.spans.find((span) => span.name === "chat claude-sonnet")!
    expect(llm.attributes["gen_ai.output.messages"]).toBeString()
    expect(llm.attributes["gen_ai.input.messages"]).toBeString()
    const tool = tracer.spans.find((span) => span.name === "execute_tool read")!
    expect(tool.attributes["gen_ai.tool.call.arguments"]).toBe('{"path":"a.ts"}')
    expect(tool.attributes["gen_ai.tool.call.result"]).toBe("file body")
  })

  test("keeps span identity even with capture off", () => {
    const { ctx, tracer } = gatedCtx()
    runTurn(ctx)
    const tool = tracer.spans.find((span) => span.name === "execute_tool read")!
    expect(tool.attributes["gen_ai.tool.name"]).toBe("read")
    expect(tool.attributes["gen_ai.tool.call.id"]).toBe("call_1")
    expect(tool.attributes["tool.success"]).toBe(true)
    expect(tool.attributes["tool.result_size_bytes"]).toBe(9)
  })
})

describe("time to first token", () => {
  test("records the histogram and span attribute in milliseconds", () => {
    const { ctx, histograms, tracer } = genAiCtx()
    seedRun(ctx)
    startStep(ctx, 1500)
    handleTextStarted(evt("session.text.started", { sessionID: "ses_1", assistantMessageID: "msg_1" }, 1900), ctx)
    handleTextEnded(evt("session.text.ended", { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, text: "hi" }), ctx)
    handleStepEnded(evt("session.step.ended", { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "stop", cost: 0, tokens: tokens() }, 2600), ctx)

    expect(histograms.ttft.calls).toHaveLength(1)
    expect(histograms.ttft.calls[0]!.value).toBe(0.4)
    expect(histograms.ttft.calls[0]!.attrs["gen_ai.request.model"]).toBe("claude-sonnet")
    expect(tracer.spans.find((span) => span.name === "chat claude-sonnet")!.attributes["gen_ai.server.time_to_first_token"]).toBe(0.4)
  })

  test("uses the earliest streamed part, so reasoning before text still counts", () => {
    const { ctx, histograms } = genAiCtx()
    seedRun(ctx)
    startStep(ctx, 1500)
    handleTextStarted(evt("session.text.started", { sessionID: "ses_1", assistantMessageID: "msg_1" }, 2100), ctx)
    handleTextStarted(evt("session.text.started", { sessionID: "ses_1", assistantMessageID: "msg_1" }, 1700, "reasoning:1"), ctx)
    handleStepEnded(evt("session.step.ended", { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "stop", cost: 0, tokens: tokens() }, 2600), ctx)
    expect(histograms.ttft.calls[0]!.value).toBe(0.2)
  })

  test("omits the attribute when the model produced no streamed output", () => {
    const { ctx, histograms, tracer } = makeCtx()
    seedRun(ctx)
    startStep(ctx, 1500)
    handleStepEnded(evt("session.step.ended", { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "stop", cost: 0, tokens: tokens() }, 2600), ctx)
    expect(histograms.ttft.calls).toHaveLength(0)
    expect(tracer.spans.find((span) => span.name === "opencode.llm")!.attributes["gen_ai.server.time_to_first_token"]).toBeUndefined()
  })
})
