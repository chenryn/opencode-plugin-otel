import { describe, test, expect } from "bun:test"
import { SpanStatusCode } from "@opentelemetry/api"
import { handleToolCalled, handleToolFailed, handleToolInputStarted, handleToolSuccess, toolFacts } from "../../src/handlers/tool.ts"
import { sha256Hex } from "../../src/facts.ts"
import { handleExecutionStarted, handleSessionCreated } from "../../src/handlers/session.ts"
import { makeCtx, evt, recordSpanContext } from "../helpers.ts"

function seed(ctx: ReturnType<typeof makeCtx>["ctx"], sessionID = "ses_1") {
  handleSessionCreated(evt("session.created", { sessionID, agent: "build" }), ctx)
  handleExecutionStarted(evt("session.execution.started", { sessionID }), ctx)
}

function inputStarted(id = "call_1", name = "bash", sessionID = "ses_1", created = 1000) {
  return evt("session.tool.input.started", { sessionID, assistantMessageID: "msg_1", id, name }, created)
}

type Execution = { executed: boolean } | { provider: { executed: boolean } }

const local: Execution = { executed: false }
const hosted: Execution = { executed: true }

function called(id: string, input: Record<string, unknown>, execution: Execution, created = 1000) {
  return evt("session.tool.called", { sessionID: "ses_1", assistantMessageID: "msg_1", id, input, ...execution }, created)
}

function succeeded(id: string, text: string, execution: Execution, created = 1000) {
  return evt("session.tool.success", { sessionID: "ses_1", assistantMessageID: "msg_1", id, content: [{ type: "text", text }], ...execution }, created)
}

function failed(id: string, error: { type: string; message: string }, execution: Execution, created = 1000) {
  return evt("session.tool.failed", { sessionID: "ses_1", assistantMessageID: "msg_1", id, error, ...execution }, created)
}

describe("handleToolInputStarted", () => {
  test("stores the tool name without counting model input streaming as execution", () => {
    const { ctx, tracer } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted(), ctx)
    expect(tracer.spans.filter((s) => s.name.startsWith("opencode.tool."))).toHaveLength(0)
    expect(ctx.tracing.toolMeta.get("call_1")!.tool).toBe("bash")
  })
})

describe("handleToolCalled", () => {
  test("attaches parameters and detects a local git commit", () => {
    const { ctx, counters, logger, tracer } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted("call_1", "shell"), ctx)
    handleToolCalled(called("call_1", { command: "git commit -m 'x'" }, local), ctx)
    expect(counters.commit.calls).toHaveLength(0)
    handleToolSuccess(succeeded("call_1", "commit made", local), ctx)
    expect(counters.commit.calls).toHaveLength(1)
    expect(logger.records.some((record) => record.body === "commit")).toBe(true)
    const span = tracer.spans.find((s) => s.name === "opencode.tool.shell")!
    const commit = logger.records.find((record) => record.body === "commit")!
    expect(recordSpanContext(commit)).toEqual(span.spanContext())
    expect(span.attributes["input.value"]).toContain("git commit")
    expect(span.attributes["tool.provider_executed"]).toBe(false)
  })

  test("ignores non-commit shell commands", () => {
    const { ctx, counters } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted(), ctx)
    handleToolCalled(called("call_1", { command: "ls -la" }, local), ctx)
    handleToolSuccess(succeeded("call_1", "listing", local), ctx)
    expect(counters.commit.calls).toHaveLength(0)
  })

  test("does not count failed git commits", () => {
    const { ctx, counters } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted(), ctx)
    handleToolCalled(called("call_1", { command: "git commit -m test" }, local), ctx)
    handleToolFailed(failed("call_1", { type: "tool.execution", message: "failed" }, local), ctx)
    expect(counters.commit.calls).toHaveLength(0)
  })
})

describe("handleToolSuccess", () => {
  test("records a locally executed tool", () => {
    const { ctx, histograms, logger, tracer } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted("call_1", "read", "ses_1", 1000), ctx)
    handleToolCalled(called("call_1", {}, local, 1000), ctx)
    handleToolSuccess(succeeded("call_1", "file body", local, 1250), ctx)
    expect(histograms.tool.calls).toHaveLength(1)
    expect(histograms.tool.calls[0]!.value).toBe(250)
    expect(histograms.tool.calls[0]!.attrs["success"]).toBe(true)
    const record = logger.records.at(-1)!
    expect(record.body).toBe("tool_result")
    expect(record.attributes?.["duration_ms"]).toBe(250)
    const span = tracer.spans.find((s) => s.name === "opencode.tool.read")!
    expect(span.startTime).toBe(1000)
    expect(span.endTime).toBe(1250)
    expect(span.status.code).toBe(SpanStatusCode.OK)
    expect(span.attributes["output.value"]).toBe("file body")
    expect(recordSpanContext(record)).toEqual(span.spanContext())
  })

  test("records a provider-executed tool", () => {
    const { ctx, histograms, tracer } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted("call_1", "web_search", "ses_1", 1000), ctx)
    handleToolCalled(called("call_1", { query: "otel" }, hosted, 1000), ctx)
    handleToolSuccess(succeeded("call_1", "results", hosted, 1040), ctx)
    expect(histograms.tool.calls[0]!.value).toBe(40)
    const span = tracer.spans.find((s) => s.name === "opencode.tool.web_search")!
    expect(span.ended).toBe(true)
    expect(span.attributes["tool.provider_executed"]).toBe(true)
  })

  test("accepts the nested provider execution shape", () => {
    const { ctx, histograms, tracer } = makeCtx()
    seed(ctx)
    for (const [id, executed] of [["call_1", false], ["call_2", true]] as const) {
      handleToolInputStarted(inputStarted(id, "read", "ses_1", 1000), ctx)
      handleToolCalled(called(id, {}, { provider: { executed } }, 1000), ctx)
      handleToolSuccess(succeeded(id, "ok", { provider: { executed } }, 1100), ctx)
    }
    expect(histograms.tool.calls.map((call) => call.value)).toEqual([100, 100])
    expect(tracer.spans.filter((s) => s.name === "opencode.tool.read").map((s) => s.attributes["tool.provider_executed"])).toEqual([false, true])
  })
})

describe("handleToolFailed", () => {
  test("records a failed local tool and ends the span with error", () => {
    const { ctx, histograms, logger, tracer } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted(), ctx)
    handleToolCalled(called("call_1", {}, local, 1000), ctx)
    handleToolFailed(failed("call_1", { type: "tool.execution", message: "nope" }, local, 1200), ctx)
    expect(histograms.tool.calls).toHaveLength(1)
    expect(histograms.tool.calls[0]!.value).toBe(200)
    expect(histograms.tool.calls[0]!.attrs["success"]).toBe(false)
    expect(logger.records.at(-1)!.attributes?.["duration_ms"]).toBe(200)
    expect(logger.records.at(-1)!.attributes?.["error"]).toBe("tool.execution: nope")
    expect(logger.records.at(-1)!.attributes?.["error.type"]).toBe("tool.execution")
    expect(logger.records.at(-1)!.attributes?.["error.message"]).toBe("nope")
    const span = tracer.spans.find((s) => s.name === "opencode.tool.bash")!
    expect(span.ended).toBe(true)
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.attributes["error.type"]).toBe("tool.execution")
  })

  test("records a failed provider-executed tool", () => {
    const { ctx, histograms, tracer } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted("call_1", "web_search"), ctx)
    handleToolCalled(called("call_1", {}, hosted, 1000), ctx)
    handleToolFailed(failed("call_1", { type: "tool.execution", message: "nope" }, hosted, 1010), ctx)
    expect(histograms.tool.calls[0]!.value).toBe(10)
    expect(histograms.tool.calls[0]!.attrs["success"]).toBe(false)
    expect(tracer.spans.find((s) => s.name === "opencode.tool.web_search")!.status.code).toBe(SpanStatusCode.ERROR)
  })

  test("records a permission rejection after the call as a failed execution", () => {
    const { ctx, histograms, tracer } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted("call_1", "shell"), ctx)
    handleToolCalled(called("call_1", { command: "git commit -m x" }, local, 1000), ctx)
    handleToolFailed(failed("call_1", { type: "permission.rejected", message: "denied" }, local, 1500), ctx)
    expect(histograms.tool.calls[0]!.value).toBe(500)
    expect(histograms.tool.calls[0]!.attrs["success"]).toBe(false)
    expect(tracer.spans.find((s) => s.name === "opencode.tool.shell")!.attributes["tool.error"]).toBe("permission.rejected: denied")
  })

  test("does not record malformed input that was never called", () => {
    const { ctx, histograms, logger, tracer } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted("call_1", "shell"), ctx)
    handleToolFailed(failed("call_1", { type: "tool.input-json", message: "malformed" }, local, 1200), ctx)
    expect(histograms.tool.calls).toHaveLength(0)
    expect(tracer.spans.some((s) => s.name.startsWith("opencode.tool."))).toBe(false)
    expect(logger.records.at(-1)!.attributes?.["duration_ms"]).toBe(0)
    expect(ctx.tracing.toolMeta.has("call_1")).toBe(false)
  })

  test("measures execution from called, excluding slow argument streaming", () => {
    const { ctx, histograms, tracer } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted("call_1", "read", "ses_1", 1000), ctx)
    handleToolCalled(called("call_1", {}, local, 5000), ctx)
    handleToolSuccess(succeeded("call_1", "ok", local, 5300), ctx)
    expect(histograms.tool.calls[0]!.value).toBe(300)
    expect(tracer.spans.find((span) => span.name === "opencode.tool.read")?.startTime).toBe(5000)
  })

  test("records a subagent call that fails before creating a child", () => {
    const { ctx, tracer, histograms } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted("call_2", "subagent"), ctx)
    handleToolCalled(called("call_2", { agent: "explore" }, local, 1000), ctx)
    handleToolFailed(failed("call_2", { type: "invalid", message: "missing input" }, local, 1100), ctx)
    const span = tracer.spans.find((s) => s.name === "opencode.tool.subagent")!
    expect(span.attributes["subagent.agent"]).toBe("explore")
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(histograms.tool.calls[0]!.value).toBe(100)
    expect(histograms.tool.calls[0]!.attrs["success"]).toBe(false)
  })
})

describe("tool facts", () => {
  test("emits the verbatim command for shell tools", () => {
    const { ctx, tracer, logger } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted("call_1", "bash"), ctx)
    handleToolCalled(called("call_1", { command: "ls -la" }, local), ctx)
    handleToolSuccess(succeeded("call_1", "listing", local), ctx)
    const span = tracer.spans.find((s) => s.name === "opencode.tool.bash")!
    expect(span.attributes["tool.command"]).toBe("ls -la")
    const result = logger.records.find((record) => record.body === "tool_result")!
    expect(result.attributes?.["tool.command"]).toBe("ls -la")
  })

  test("emits file.operation and file.path for file tools", () => {
    const { ctx, tracer, logger } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted("call_read", "read"), ctx)
    handleToolCalled(called("call_read", { path: "/tmp/a.ts" }, local), ctx)
    handleToolSuccess(succeeded("call_read", "contents", local), ctx)
    const span = tracer.spans.find((s) => s.name === "opencode.tool.read")!
    expect(span.attributes["file.operation"]).toBe("read")
    expect(span.attributes["file.path"]).toBe("/tmp/a.ts")
    const result = logger.records.find((record) => record.body === "tool_result")!
    expect(result.attributes?.["file.operation"]).toBe("read")
    expect(result.attributes?.["file.path"]).toBe("/tmp/a.ts")
  })

  test("emits file.paths for multi-path edits", () => {
    const { ctx, tracer } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted("call_edit", "multiedit"), ctx)
    handleToolCalled(called("call_edit", { edits: [{ path: "/tmp/a.ts" }, { path: "/tmp/b.ts" }] }, local), ctx)
    const span = tracer.spans.find((s) => s.name === "opencode.tool.multiedit")!
    expect(span.attributes["file.operation"]).toBe("edit")
    expect(span.attributes["file.paths"]).toEqual(["/tmp/a.ts", "/tmp/b.ts"])
    expect(span.attributes["file.path"]).toBeUndefined()
  })

  test("omits facts when the tool is not mapped", () => {
    const { ctx, tracer } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted("call_1", "webfetch"), ctx)
    handleToolCalled(called("call_1", { url: "https://example.com" }, local), ctx)
    const span = tracer.spans.find((s) => s.name === "opencode.tool.webfetch")!
    expect(span.attributes["file.operation"]).toBeUndefined()
    expect(span.attributes["tool.command"]).toBeUndefined()
  })

  test("respects captureToolFacts=false", () => {
    const { ctx, tracer, logger } = makeCtx("proj_test", [], [], true, {}, "openinference", true, true, false)
    seed(ctx)
    handleToolInputStarted(inputStarted("call_1", "bash"), ctx)
    handleToolCalled(called("call_1", { command: "ls -la" }, local), ctx)
    handleToolSuccess(succeeded("call_1", "listing", local), ctx)
    const span = tracer.spans.find((s) => s.name === "opencode.tool.bash")!
    expect(span.attributes["tool.command"]).toBeUndefined()
    const result = logger.records.find((record) => record.body === "tool_result")!
    expect(result.attributes?.["tool.command"]).toBeUndefined()
  })

  test("keeps the call and result when input.started was missed", () => {
    const { ctx, tracer, logger } = makeCtx()
    seed(ctx)
    handleToolCalled(called("call_1", { path: "/tmp/a.ts" }, local), ctx)
    handleToolSuccess(succeeded("call_1", "contents", local), ctx)
    expect(tracer.spans.some((s) => s.name === "opencode.tool.unknown")).toBe(true)
    const result = logger.records.find((record) => record.body === "tool_result")!
    expect(result.attributes?.["success"]).toBe(true)
    expect(result.attributes?.["file.operation"]).toBeUndefined()
  })
})

describe("tool fingerprints and semantics", () => {
  test("writes an argument hash without capturing the arguments", () => {
    const { ctx, tracer } = makeCtx("proj_test", [], [], true, {}, "openinference", false, true, false)
    seed(ctx)
    handleToolInputStarted(inputStarted("call_1", "bash"), ctx)
    handleToolCalled(called("call_1", { command: "ls -la" }, local), ctx)
    handleToolSuccess(succeeded("call_1", "listing", local), ctx)
    const span = tracer.spans.find((s) => s.name === "opencode.tool.bash")!
    expect(span.attributes["opencode.tool.args.hash"]).toBe(sha256Hex('{"command":"ls -la"}'))
    expect(span.attributes["input.value"]).toBeUndefined()
    expect(span.attributes["opencode.tool.result.hash"]).toBe(sha256Hex("listing"))
  })

  test("records the destination and data source for a webfetch", () => {
    const { ctx, tracer, logger } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted("call_1", "webfetch"), ctx)
    handleToolCalled(called("call_1", { url: "https://example.com/doc?token=x" }, local), ctx)
    handleToolSuccess(succeeded("call_1", "body", local), ctx)
    const span = tracer.spans.find((s) => s.name === "opencode.tool.webfetch")!
    expect(span.attributes["url.domain"]).toBe("example.com")
    expect(span.attributes["url.full"]).toBe("https://example.com/doc")
    expect(span.attributes["gen_ai.data_source.type"]).toBe("web")
    const result = logger.records.find((record) => record.body === "tool_result")!
    expect(result.attributes?.["url.domain"]).toBe("example.com")
  })

  test("records the exit code from result metadata", () => {
    const { ctx, tracer, logger } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted("call_1", "bash"), ctx)
    handleToolCalled(called("call_1", { command: "exit 1" }, local), ctx)
    const event = evt("session.tool.failed", {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      id: "call_1",
      error: { type: "tool.execution", message: "failed" },
      content: [{ type: "text", text: "boom" }],
      metadata: { exitCode: 1 },
      ...local,
    }, 1000)
    handleToolFailed(event, ctx)
    const span = tracer.spans.find((s) => s.name === "opencode.tool.bash")!
    expect(span.attributes["opencode.tool.exit_code"]).toBe(1)
    const result = logger.records.find((record) => record.body === "tool_result")!
    expect(result.attributes?.["opencode.tool.exit_code"]).toBe(1)
  })

  test("records memory and mcp identity", () => {
    const { ctx, tracer } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted("call_1", "memory_save"), ctx)
    handleToolCalled(called("call_1", { text: "x" }, local), ctx)
    handleToolSuccess(succeeded("call_1", "ok", local), ctx)
    const span = tracer.spans.find((s) => s.name === "opencode.tool.memory_save")!
    expect(span.attributes["gen_ai.memory.operation"]).toBe("save")
    expect(span.attributes["gen_ai.data_source.type"]).toBe("memory")
  })
})

describe("toolFacts", () => {
  test("maps tools and normalizes namespaced tool ids", () => {
    expect(toolFacts("filesystem.read", { path: "a.ts" })).toEqual({ operation: "read", paths: ["a.ts"] })
    expect(toolFacts("write", { filePath: "b.ts" })).toEqual({ operation: "write", paths: ["b.ts"] })
    expect(toolFacts("glob", { pattern: "**/*.ts" })).toEqual({ operation: "glob" })
    expect(toolFacts("grep", { pattern: "x" })).toEqual({ operation: "search" })
    expect(toolFacts("bash", { command: "pwd" })).toEqual({ command: "pwd" })
    expect(toolFacts("webfetch", { url: "x" })).toBeUndefined()
  })
})