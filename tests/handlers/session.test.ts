import { describe, test, expect } from "bun:test"
import { SpanStatusCode } from "@opentelemetry/api"
import {
  finalizeSession,
  handleExecutionEnded,
  handleExecutionStarted,
  handleAgentSelected,
  handlePromptEnqueued,
  handleSessionCreated,
  handleSessionIdle,
  handleSessionStatus,
  handleRetryScheduled,
  handleUsageUpdated,
} from "../../src/handlers/session.ts"
import { makeCtx, evt, recordSpanContext, tokens } from "../helpers.ts"

describe("handleSessionCreated", () => {
  test("increments the session counter and stores totals", () => {
    const { ctx, counters } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1", created: 1000, projectID: "proj_test", location: {}, slug: "s", version: "1" }), ctx)
    expect(counters.session.calls).toHaveLength(1)
    expect(counters.session.calls[0]!.attrs["session.id"]).toBe("ses_1")
    expect(counters.session.calls[0]!.attrs["is_subagent"]).toBe(false)
    const totals = ctx.tracing.sessionTotals.get("ses_1")!
    expect(totals.startMs).toBe(1000)
    expect(totals.agentType).toBe("primary")
  })

  test("marks subagent sessions and increments the subtask counter", () => {
    const { ctx, counters, logger } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "sub_1", parentID: "ses_1", agent: "explore" }), ctx)
    expect(counters.session.calls[0]!.attrs["is_subagent"]).toBe(true)
    expect(counters.subtask.calls).toHaveLength(1)
    expect(ctx.tracing.sessionTotals.get("sub_1")!.parentID).toBe("ses_1")
    expect(logger.records[0]!.attributes?.["agent.name"]).toBe("explore")
    expect(logger.records.some((record) => record.body === "subtask_invoked")).toBe(true)
  })

  test("correlates subagent log events with the parent run", () => {
    const { ctx, logger, tracer } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1", projectID: "p" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    handleSessionCreated(evt("session.created", { sessionID: "sub_1", parentID: "ses_1", agent: "explore" }), ctx)
    const parentRun = tracer.spans.find((span) => span.name === "opencode.session")!
    const created = logger.records.find((record) => record.body === "session.created" && record.attributes?.["session.id"] === "sub_1")!
    expect(recordSpanContext(created)).toEqual(parentRun.spanContext())
  })
})

describe("handlePromptEnqueued", () => {
  test("logs admitted user prompts and stores their text for spans", () => {
    const { ctx, logger } = makeCtx()
    handlePromptEnqueued(evt("session.inbox.enqueued", {
      sessionID: "ses_1",
      inboxID: "msg_1",
      item: { type: "user", payload: { text: "hello", files: [], agents: [], skills: [] }, delivery: "queue" },
    }), ctx, false)
    expect(logger.records[0]!.body).toBe("user_prompt")
    expect(logger.records[0]!.attributes?.["delivery"]).toBe("queue")
    expect(logger.records[0]!.attributes?.["prompt"]).toBeUndefined()
    expect(ctx.tracing.pendingPrompts.get("ses_1")![0]!.text).toBe("hello")
  })

  test("skips non-user inbox items", () => {
    const { ctx, logger } = makeCtx()
    handlePromptEnqueued(evt("session.inbox.enqueued", {
      sessionID: "ses_1", inboxID: "msg_2", item: { type: "synthetic", payload: { text: "hidden" }, delivery: "steer" },
    }), ctx, true)
    expect(logger.records).toHaveLength(0)
  })
})

describe("handleExecutionStarted", () => {
  test("starts a run span and attaches the pending prompt", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1" }), ctx)
    ctx.tracing.pendingPrompts.set("ses_1", [{ text: "hello", startMs: 1 }])
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }, 2000), ctx)
    const span = tracer.spans[0]!
    expect(span.name).toBe("opencode.session")
    expect(span.startTime).toBe(2000)
    expect(span.attributes["input.value"]).toBe("hello")
    expect(ctx.tracing.runSpans.has("ses_1")).toBe(true)
    expect(ctx.tracing.activePrompts.get("ses_1")!.text).toBe("hello")
  })

  test("nests subagent runs under the parent run span", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }, 100), ctx)
    handleSessionCreated(evt("session.created", { sessionID: "sub_1", parentID: "ses_1" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "sub_1" }, 200), ctx)
    const parentRun = tracer.spans.find((s) => s.attributes["session.id"] === "ses_1")!
    const subRun = tracer.spans.find((s) => s.attributes["session.id"] === "sub_1")!
    expect(subRun.parentSpan).toBe(parentRun)
    expect(subRun.attributes["parent_session_id"]).toBe("ses_1")
    expect(parentRun.attributes["parent_session_id"]).toBeUndefined()
  })

  test("lazily initializes and counts a session with no session.created event", () => {
    const { ctx, counters } = makeCtx()
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_new" }, 100), ctx)
    expect(ctx.tracing.sessionTotals.has("ses_new")).toBe(true)
    expect(counters.session.calls).toHaveLength(1)
  })

  test("keeps a subagent identity across executions", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "parent", projectID: "p" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "parent" }), ctx)
    handleSessionCreated(evt("session.created", { sessionID: "sub", parentID: "parent", agent: "explore", projectID: "p" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "sub" }), ctx)
    handleExecutionEnded(evt("session.execution.succeeded", { sessionID: "sub" }), ctx, { type: "succeeded" })
    finalizeSession("sub", ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "sub" }), ctx)
    expect(ctx.tracing.sessionTotals.get("sub")?.agentType).toBe("subagent")
    expect(ctx.tracing.sessionTotals.get("sub")?.agent).toBe("explore")
    expect(tracer.spans.at(-1)?.parentSpan).toBe(tracer.spans[0])
  })

  test("retains an agent selection through finalization and the next execution", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1", projectID: "p", agent: "build" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    handleAgentSelected(evt("session.agent.selected", { sessionID: "ses_1", agent: "explore" }), ctx)
    handleExecutionEnded(evt("session.execution.succeeded", { sessionID: "ses_1" }), ctx, { type: "succeeded" })
    finalizeSession("ses_1", ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    expect(tracer.spans.at(-1)?.attributes["agent.name"]).toBe("explore")
  })

  test("preserves cumulative totals if the next execution ends before a usage update", () => {
    const { ctx, histograms, tracer } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1", projectID: "p" }), ctx)
    handleUsageUpdated(evt("session.usage.updated", { sessionID: "ses_1", cost: 1.25, tokens: tokens(10, 5) }), ctx)
    finalizeSession("ses_1", ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    handleExecutionEnded(evt("session.execution.failed", { sessionID: "ses_1", error: { type: "x", message: "y" } }), ctx, {
      type: "failed", error: { type: "x", message: "y" },
    })
    finalizeSession("ses_1", ctx)
    expect(histograms.sessionToken.calls.map((call) => call.value)).toEqual([15, 15])
    expect(histograms.sessionCost.calls.map((call) => call.value)).toEqual([1.25, 1.25])
    expect(tracer.spans.at(-1)?.attributes["session.total_tokens"]).toBe(15)
  })

  test("retains a prompt queued during the current execution for the next run", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1", projectID: "p" }), ctx)
    const prompt = (text: string) => evt("session.inbox.enqueued", {
      sessionID: "ses_1", inboxID: text,
      item: { type: "user", payload: { text }, delivery: "queue" },
    })
    handlePromptEnqueued(prompt("first"), ctx, false)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    handlePromptEnqueued(prompt("second"), ctx, false)
    handleExecutionEnded(evt("session.execution.succeeded", { sessionID: "ses_1" }), ctx, { type: "succeeded" })
    finalizeSession("ses_1", ctx)
    expect(ctx.tracing.pendingPrompts.get("ses_1")?.[0]?.text).toBe("second")
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    expect(tracer.spans.at(-1)?.attributes["input.value"]).toBe("second")
  })

  test("applies a steering prompt to the current run, not the next run", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1", projectID: "p" }), ctx)
    handlePromptEnqueued(evt("session.inbox.enqueued", {
      sessionID: "ses_1", inboxID: "first", item: { type: "user", payload: { text: "first" }, delivery: "steer" },
    }), ctx, false)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    handlePromptEnqueued(evt("session.inbox.enqueued", {
      sessionID: "ses_1", inboxID: "steering", item: { type: "user", payload: { text: "steering" }, delivery: "steer" },
    }), ctx, false)
    handlePromptEnqueued(evt("session.inbox.enqueued", {
      sessionID: "ses_1", inboxID: "second", item: { type: "user", payload: { text: "second" }, delivery: "queue" },
    }), ctx, false)
    expect(ctx.tracing.activePrompts.get("ses_1")?.text).toBe("first\nsteering")
    handleExecutionEnded(evt("session.execution.succeeded", { sessionID: "ses_1" }), ctx, { type: "succeeded" })
    finalizeSession("ses_1", ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    expect(tracer.spans.at(-1)?.attributes["input.value"]).toBe("second")
  })
})

describe("handleExecutionEnded", () => {
  test("ends the run span OK and records totals", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1", agent: "build" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    handleExecutionEnded(evt("session.execution.succeeded", { sessionID: "ses_1" }, 5000), ctx, { type: "succeeded" })
    const span = tracer.spans[0]!
    expect(span.ended).toBe(true)
    expect(span.endTime).toBe(5000)
    expect(span.status.code).toBe(SpanStatusCode.OK)
    expect(span.attributes["agent.name"]).toBe("build")
  })

  test("failed execution ends the span with an error and emits session.error", () => {
    const { ctx, tracer, logger } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    handleExecutionEnded(
      evt("session.execution.failed", { sessionID: "ses_1", error: { type: "ProviderError", message: "boom" } }),
      ctx,
      { type: "failed", error: { type: "ProviderError", message: "boom" } },
    )
    expect(tracer.spans[0]!.status.code).toBe(SpanStatusCode.ERROR)
    expect(logger.records.at(-1)!.body).toBe("session.error")
    expect(logger.records.at(-1)!.attributes?.["error"]).toBe("ProviderError: boom")
    expect(recordSpanContext(logger.records.at(-1)!)).toEqual(tracer.spans[0]!.spanContext())
  })

  test("keeps the run span context until the session finalizes so idle logs correlate", () => {
    const { ctx, logger, tracer } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1" }, 100), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    handleExecutionEnded(evt("session.execution.succeeded", { sessionID: "ses_1" }), ctx, { type: "succeeded" })
    finalizeSession("ses_1", ctx)
    const idle = logger.records.find((record) => record.body === "session.idle")!
    expect(recordSpanContext(idle)).toEqual(tracer.spans[0]!.spanContext())
    expect(ctx.tracing.runSpanContexts.has("ses_1")).toBe(false)
  })
})

describe("handleSessionStatus", () => {
  test("counts durable retry events once rather than retry status", () => {
    const { ctx, counters } = makeCtx("proj_test", [], [], true, {}, "gen_ai")
    handleSessionStatus(evt("session.status", { sessionID: "ses_1", status: { type: "retry", attempt: 1, message: "m", next: 2 } }), ctx)
    expect(counters.retry.calls).toHaveLength(0)
    handleRetryScheduled(evt("session.retry.scheduled", { sessionID: "ses_1", assistantMessageID: "m", attempt: 1, at: 2, error: { type: "x", message: "y" } }), ctx)
    expect(counters.retry.calls).toHaveLength(1)
    const attrs = counters.retry.calls[0]!.attrs
    expect(attrs["session.id"]).toBe("ses_1")
    expect(attrs["gen_ai.conversation.id"]).toBe("ses_1")
    expect(attrs["retry.attempt"]).toBe(1)
    expect(attrs["error.type"]).toBe("x")
    expect(attrs["session.retry.count"]).toBeUndefined()
  })

  test("records the per-execution retry count on the run span", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    const run = tracer.spans.find((span) => span.attributes["session.id"] === "ses_1")!
    for (const attempt of [1, 2]) {
      handleRetryScheduled(evt("session.retry.scheduled", {
        sessionID: "ses_1",
        assistantMessageID: "m",
        attempt,
        at: 2,
        error: { type: "ProviderError", message: "rate limited", status: 429 },
      }, 2000 + attempt, `retry:${attempt}`), ctx)
    }
    expect(run.attributes["retry.attempt"]).toBe(2)
    expect(run.attributes["session.retry.count"]).toBe(2)
    expect(run.attributes["error.type"]).toBe("ProviderError")
    expect(run.attributes["error.status"]).toBe(429)
  })

  test("tolerates retries without a run span and resets the count per execution", () => {
    const { ctx, tracer } = makeCtx("proj_test", [], ["session"])
    handleSessionCreated(evt("session.created", { sessionID: "ses_1" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    handleRetryScheduled(evt("session.retry.scheduled", { sessionID: "ses_1", assistantMessageID: "m", attempt: 1, at: 2, error: { type: "x", message: "y" } }), ctx)
    expect(ctx.tracing.sessionRetries.get("ses_1")).toBe(1)
    expect(tracer.spans).toHaveLength(0)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    expect(ctx.tracing.sessionRetries.has("ses_1")).toBe(false)
  })

  test("idle records duration and session totals then clears state", () => {
    const { ctx, histograms, logger } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1" }, 100), ctx)
    ctx.tracing.sessionTotals.set("ses_1", { startMs: 100, tokens: 42, cost: 0.5, messages: 3, agent: "build", agentType: "primary" })
    handleSessionStatus(evt("session.status", { sessionID: "ses_1", status: { type: "idle" } }), ctx)
    expect(histograms.sessionDuration.calls).toHaveLength(1)
    expect(histograms.sessionToken.calls[0]!.value).toBe(42)
    expect(histograms.sessionCost.calls[0]!.value).toBe(0.5)
    expect(logger.records.at(-1)!.body).toBe("session.idle")
    expect(ctx.tracing.sessionTotals.has("ses_1")).toBe(false)
  })
})

describe("handleUsageUpdated", () => {
  test("stores cumulative tokens including cache", () => {
    const { ctx } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1" }), ctx)
    handleUsageUpdated(evt("session.usage.updated", { sessionID: "ses_1", cost: 1.25, tokens: tokens(10, 5, 2, 3, 4) }), ctx)
    const totals = ctx.tracing.sessionTotals.get("ses_1")!
    expect(totals.tokens).toBe(24)
    expect(totals.cost).toBe(1.25)
  })
})

describe("handleSessionIdle", () => {
  test("finalizes via the deprecated idle event", () => {
    const { ctx, logger } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1" }, 100), ctx)
    handleSessionIdle(evt("session.idle", { sessionID: "ses_1" }), ctx)
    expect(logger.records.at(-1)!.body).toBe("session.idle")
  })

  test("finalizeSession is idempotent", () => {
    const { ctx, histograms } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1" }, 100), ctx)
    finalizeSession("ses_1", ctx)
    finalizeSession("ses_1", ctx)
    expect(histograms.sessionDuration.calls).toHaveLength(1)
  })
})

describe("skills", () => {
  test("records skill names on the prompt event and the run span", () => {
    const { ctx, logger, tracer } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1", projectID: "p" }), ctx)
    handlePromptEnqueued(evt("session.inbox.enqueued", {
      sessionID: "ses_1",
      inboxID: "msg_1",
      item: {
        type: "user",
        payload: { text: "review this", skills: [{ id: "sk_1", name: "review" }, { id: "sk_2", name: "test" }] },
        delivery: "queue",
      },
    }), ctx, false)
    const prompt = logger.records.find((record) => record.body === "user_prompt")!
    expect(prompt.attributes?.["skill.name"]).toEqual(["review", "test"])
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    expect(tracer.spans.at(-1)?.attributes["skill.name"]).toEqual(["review", "test"])
  })

  test("writes no skill attribute when the prompt has none", () => {
    const { ctx, logger, tracer } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1", projectID: "p" }), ctx)
    handlePromptEnqueued(evt("session.inbox.enqueued", {
      sessionID: "ses_1",
      inboxID: "msg_1",
      item: { type: "user", payload: { text: "plain", skills: [] }, delivery: "queue" },
    }), ctx, false)
    const prompt = logger.records.find((record) => record.body === "user_prompt")!
    expect(prompt.attributes?.["skill.name"]).toBeUndefined()
    expect(ctx.tracing.pendingPrompts.get("ses_1")![0]!.skills).toBeUndefined()
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    expect(tracer.spans.at(-1)?.attributes["skill.name"]).toBeUndefined()
  })

  test("merges skill names for a steering prompt", () => {
    const { ctx } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1", projectID: "p" }), ctx)
    handlePromptEnqueued(evt("session.inbox.enqueued", {
      sessionID: "ses_1",
      inboxID: "first",
      item: { type: "user", payload: { text: "first", skills: [{ id: "s1", name: "review" }] }, delivery: "steer" },
    }), ctx, false)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    handlePromptEnqueued(evt("session.inbox.enqueued", {
      sessionID: "ses_1",
      inboxID: "steering",
      item: { type: "user", payload: { text: "steering", skills: [{ id: "s1", name: "review" }, { id: "s2", name: "test" }] }, delivery: "steer" },
    }), ctx, false)
    expect(ctx.tracing.activePrompts.get("ses_1")?.skills).toEqual(["review", "test"])
  })

  test("deduplicates and caps skill names", () => {
    const { ctx, logger } = makeCtx()
    const skills = Array.from({ length: 25 }, (_, index) => ({ id: `s${index}`, name: `skill-${index}` }))
    handlePromptEnqueued(evt("session.inbox.enqueued", {
      sessionID: "ses_1",
      inboxID: "msg_1",
      item: { type: "user", payload: { text: "x", skills: [skills[0]!, ...skills] }, delivery: "queue" },
    }), ctx, false)
    const prompt = logger.records.find((record) => record.body === "user_prompt")!
    expect((prompt.attributes?.["skill.name"] as string[]).length).toBe(20)
  })
})

describe("prompt truncation", () => {
  test("caps the prompt attribute and keeps the original length", () => {
    const { ctx, logger } = makeCtx()
    const text = "p".repeat(20_001)
    handlePromptEnqueued(evt("session.inbox.enqueued", {
      sessionID: "ses_1",
      inboxID: "msg_1",
      item: { type: "user", payload: { text }, delivery: "queue" },
    }), ctx, true)
    const prompt = logger.records.find((record) => record.body === "user_prompt")!
    expect(String(prompt.attributes?.["prompt"]).length).toBe(20_000)
    expect(prompt.attributes?.["prompt.truncated"]).toBe(true)
    expect(prompt.attributes?.["prompt.original_length"]).toBe(20_001)
    expect(prompt.attributes?.["prompt_length"]).toBe(20_001)
  })
})
