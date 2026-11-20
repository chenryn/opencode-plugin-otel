import { describe, test, expect } from "bun:test"
import { SpanStatusCode } from "@opentelemetry/api"
import { handleCompactionEnded, handleCompactionFailed, handleCompactionStarted } from "../../src/handlers/compaction.ts"
import { handleExecutionStarted, handleSessionCreated } from "../../src/handlers/session.ts"
import { evt, makeCtx, tokens } from "../helpers.ts"

function seedSession(ctx: ReturnType<typeof makeCtx>["ctx"]) {
  handleSessionCreated(evt("session.created", { sessionID: "ses_1", agent: "build" }), ctx)
  handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
}

describe("compaction tracing", () => {
  test("traces a successful compaction as a child of the run span", () => {
    const { ctx, tracer, logger } = makeCtx()
    seedSession(ctx)
    handleCompactionStarted(evt("session.compaction.started", { sessionID: "ses_1", reason: "auto", recent: "x".repeat(40) }, 1500), ctx)
    handleCompactionEnded(evt("session.compaction.ended", {
      sessionID: "ses_1",
      reason: "auto",
      text: "compacted summary",
      recent: "x".repeat(40),
      cost: 0.4,
      tokens: tokens(100, 20, 2, 5, 0),
    }, 2500), ctx)

    const span = tracer.spans.find((s) => s.name === "opencode.compaction")!
    const run = tracer.spans.find((s) => s.name === "opencode.session")!
    expect(span.parentSpan).toBe(run)
    expect(span.ended).toBe(true)
    expect(span.status.code).toBe(SpanStatusCode.OK)
    expect(span.attributes["compaction.reason"]).toBe("auto")
    expect(span.attributes["duration_ms"]).toBe(1000)
    expect(span.attributes["output.value"]).toBe("compacted summary")
    expect(span.attributes["cost_usd"]).toBe(0.4)
    expect(span.attributes["llm.token_count.prompt"]).toBe(100)

    const event = logger.records.find((record) => record.body === "compaction")!
    expect(event.attributes?.success).toBe(true)
    expect(event.attributes?.duration_ms).toBe(1000)
    expect(event.attributes?.input_tokens).toBe(100)
    expect(event.severityText).toBe("INFO")
    expect(ctx.tracing.compactionSpans.has("ses_1")).toBe(false)
  })

  test("reports a failed compaction with the structured error", () => {
    const { ctx, tracer, logger } = makeCtx()
    seedSession(ctx)
    handleCompactionStarted(evt("session.compaction.started", { sessionID: "ses_1", reason: "manual", recent: "" }, 1000), ctx)
    handleCompactionFailed(evt("session.compaction.failed", {
      sessionID: "ses_1",
      reason: "manual",
      error: { type: "provider_error", message: "context too large", status: 400 },
    }, 1200), ctx)

    const span = tracer.spans.find((s) => s.name === "opencode.compaction")!
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.attributes["error.type"]).toBe("provider_error")
    expect(span.attributes["error.status"]).toBe(400)

    const event = logger.records.find((record) => record.body === "compaction")!
    expect(event.attributes?.success).toBe(false)
    expect(event.attributes?.["error.type"]).toBe("provider_error")
    expect(event.severityText).toBe("ERROR")
  })

  test("does not create a span when llm traces are disabled", () => {
    const { ctx, tracer } = makeCtx("proj_test", [], ["llm"])
    seedSession(ctx)
    handleCompactionStarted(evt("session.compaction.started", { sessionID: "ses_1", reason: "auto", recent: "" }), ctx)
    expect(tracer.spans.some((span) => span.name === "opencode.compaction")).toBe(false)
  })

  test("keeps the summary out of the span when content capture is off", () => {
    const { ctx, tracer } = makeCtx("proj_test", [], [], true, {}, "gen_ai", false)
    seedSession(ctx)
    handleCompactionStarted(evt("session.compaction.started", { sessionID: "ses_1", reason: "auto", recent: "" }), ctx)
    handleCompactionEnded(evt("session.compaction.ended", { sessionID: "ses_1", reason: "auto", text: "secret", recent: "" }, 2000), ctx)
    const span = tracer.spans.find((s) => s.name === "opencode.compaction")!
    expect(span.attributes["output.value"]).toBeUndefined()
    expect(span.attributes["gen_ai.output.messages"]).toBeUndefined()
  })
})
