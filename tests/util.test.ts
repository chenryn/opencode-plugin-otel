import { describe, test, expect } from "bun:test"
import { trace } from "@opentelemetry/api"
import { MAX_PENDING } from "../src/types.ts"
import {
  CONTENT_LIMIT,
  currentTurnID,
  errorSummary,
  eventContext,
  genAiProviderName,
  markSeen,
  modelRef,
  nextTurnID,
  normalizeNames,
  sessionSpanContext,
  setBoundedMap,
  totalTokens,
  truncateContent,
  truncationAttrs,
} from "../src/util.ts"
import { makeCtx } from "./helpers.ts"

describe("errorSummary", () => {
  test("formats structured errors", () => {
    expect(errorSummary({ type: "ProviderError", message: "boom" })).toBe("ProviderError: boom")
    expect(errorSummary(undefined)).toBe("unknown")
  })
})

describe("turn ids", () => {
  test("allocate a strictly increasing session-scoped sequence", () => {
    const { ctx } = makeCtx()
    expect(currentTurnID("ses_1", ctx)).toBeUndefined()
    expect(nextTurnID("ses_1", ctx)).toBe("ses_1:1")
    expect(nextTurnID("ses_1", ctx)).toBe("ses_1:2")
    expect(currentTurnID("ses_1", ctx)).toBe("ses_1:2")
    expect(nextTurnID("ses_2", ctx)).toBe("ses_2:1")
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

describe("truncateContent", () => {
  test("leaves values inside the limit untouched", () => {
    expect(truncateContent("hello")).toEqual({ text: "hello", truncated: false, originalLength: 5 })
    expect(truncateContent(undefined)).toEqual({ text: "", truncated: false, originalLength: 0 })
    expect(truncateContent("")).toEqual({ text: "", truncated: false, originalLength: 0 })
  })

  test("reports the original length when cutting", () => {
    const value = "x".repeat(CONTENT_LIMIT + 5)
    const result = truncateContent(value)
    expect(result.truncated).toBe(true)
    expect(result.originalLength).toBe(CONTENT_LIMIT + 5)
    expect(result.text.length).toBe(CONTENT_LIMIT)
  })

  test("cuts by code point so surrogate pairs stay intact", () => {
    const result = truncateContent("😀😀😀", 2)
    expect(result.truncated).toBe(true)
    expect(result.originalLength).toBe(3)
    expect(result.text).toBe("😀😀")
    expect(result.text.isWellFormed()).toBe(true)
  })

  test("accepts an explicit limit", () => {
    expect(truncateContent("abcdef", 3)).toEqual({ text: "abc", truncated: true, originalLength: 6 })
  })
})

describe("truncationAttrs", () => {
  test("writes markers only when a value was cut", () => {
    expect(truncationAttrs("tool.result", { text: "abc", truncated: false, originalLength: 3 })).toEqual({})
    expect(truncationAttrs("tool.result", { text: "abc", truncated: true, originalLength: 9 })).toEqual({
      "tool.result.truncated": true,
      "tool.result.original_length": 9,
    })
  })
})

describe("normalizeNames", () => {
  test("trims, drops empties, and removes duplicates in order", () => {
    expect(normalizeNames([" a ", "b", "a", "", "  "], 10, 10)).toEqual(["a", "b"])
  })

  test("caps the entry length and list size", () => {
    expect(normalizeNames(["abcdef", "ghijkl"], 2, 3)).toEqual(["abc", "ghi"])
    expect(normalizeNames(undefined, 2, 3)).toEqual([])
  })
})
