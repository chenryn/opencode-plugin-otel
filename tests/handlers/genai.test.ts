import { describe, test, expect } from "bun:test"
import { SpanStatusCode } from "@opentelemetry/api"
import { handleExecutionEnded, handleExecutionStarted, handleSessionCreated } from "../../src/handlers/session.ts"
import { handleStepEnded, handleStepFailed, handleStepStarted, handleTextEnded, handleTextStarted } from "../../src/handlers/step.ts"
import { handleToolCalled, handleToolInputStarted, handleToolSuccess } from "../../src/handlers/tool.ts"
import { makeCtx, evt, tokens } from "../helpers.ts"

function genAiCtx() {
  return makeCtx("proj_test", [], [], true, {}, "gen_ai")
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
