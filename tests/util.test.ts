import { describe, test, expect } from "bun:test"
import { trace } from "@opentelemetry/api"
import { MAX_PENDING } from "../src/types.ts"
import { eventContext, errorSummary, genAiProviderName, markSeen, modelRef, setBoundedMap, sessionSpanContext, totalTokens } from "../src/util.ts"
import { makeCtx } from "./helpers.ts"

describe("errorSummary", () => {
  test("formats structured errors", () => {
    expect(errorSummary({ type: "ProviderError", message: "boom" })).toBe("ProviderError: boom")
    expect(errorSummary(undefined)).toBe("unknown")
  })
})

describe("genAiProviderName", () => {
  test("maps known providers and preserves unknown ones", () => {
    expect(genAiProviderName("amazon-bedrock")).toBe("aws.bedrock")
    expect(genAiProviderName("custom")).toBe("custom")
  })
})

describe("totalTokens", () => {
  test("sums input, output, and reasoning only", () => {
    expect(totalTokens({ input: 1, output: 2, reasoning: 3, cache: { read: 10, write: 10 } })).toBe(6)
    expect(totalTokens(undefined)).toBe(0)
  })
})

describe("modelRef", () => {
  test("formats provider/id", () => {
    expect(modelRef({ providerID: "anthropic", id: "claude" })).toBe("anthropic/claude")
    expect(modelRef(undefined)).toBe("unknown")
  })
})

describe("setBoundedMap", () => {
  test("evicts the oldest entry at capacity", () => {
    const map = new Map<number, number>()
    for (let i = 0; i < MAX_PENDING; i++) setBoundedMap(map, i, i)
    expect(map.size).toBe(MAX_PENDING)
    setBoundedMap(map, MAX_PENDING, MAX_PENDING)
    expect(map.size).toBe(MAX_PENDING)
    expect(map.has(0)).toBe(false)
  })
})

describe("markSeen", () => {
  test("records unique event ids", () => {
    const seen = new Set<string>()
    markSeen(seen, "a")
    markSeen(seen, "b")
    expect(seen.has("a")).toBe(true)
    expect(seen.size).toBe(2)
  })
})

const SPAN_CONTEXT = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags: 1,
}

describe("eventContext", () => {
  test("stamps a valid span context onto the log-record context", () => {
    const context = eventContext(SPAN_CONTEXT)!
    expect(trace.getSpanContext(context)).toEqual(SPAN_CONTEXT)
  })

  test("omits an absent or invalid span context", () => {
    expect(eventContext(undefined)).toBeUndefined()
    expect(eventContext({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 })).toBeUndefined()
  })
})

describe("sessionSpanContext", () => {
  test("prefers the session's own run and falls back to the parent run", () => {
    const { ctx } = makeCtx()
    ctx.tracing.runSpanContexts.set("ses_1", SPAN_CONTEXT)
    expect(sessionSpanContext("ses_1", ctx)).toEqual(SPAN_CONTEXT)

    ctx.tracing.sessionIdentity.set("sub_1", { agent: "explore", agentType: "subagent", parentID: "ses_1", startMs: 1 })
    expect(sessionSpanContext("sub_1", ctx)).toEqual(SPAN_CONTEXT)
    expect(sessionSpanContext("unknown", ctx)).toBeUndefined()
  })
})
