import { describe, test, expect } from "bun:test"
import { createTraceStore } from "../src/trace-store.ts"
import type { SpanContext } from "@opentelemetry/api"

const runContext: SpanContext = { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 }
const stepContext: SpanContext = { traceId: "a".repeat(32), spanId: "c".repeat(16), traceFlags: 1 }

function makeStorage() {
  const entries = new Map<string, unknown>()
  const removed: string[] = []
  const storage = {
    get: async (key: string) => entries.get(key) as never,
    set: async (key: string, value: unknown) => { entries.set(key, value) },
    remove: async (key: string) => { entries.delete(key); removed.push(key) },
    scan: async () => ({ entries: [] }),
  }
  return { storage: storage as never, entries, removed }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("trace store", () => {
  test("persists the run and step context under one key and restores it", async () => {
    const { storage, entries } = makeStorage()
    const store = createTraceStore(storage, () => {})
    store.saveRun("ses_1", runContext)
    store.saveStep("ses_1", "msg_1", stepContext)
    await flush()

    expect([...entries.keys()]).toEqual(["chenryn.otel/tracing/1/ses_1"])
    const restored = await createTraceStore(storage, () => {}).load("ses_1")
    expect(restored?.run).toEqual(runContext)
    expect(restored?.step?.messageID).toBe("msg_1")
    expect(restored?.step?.spanContext).toEqual(stepContext)
  })

  test("a run-context save does not drop the step that was already written", async () => {
    const { storage } = makeStorage()
    const store = createTraceStore(storage, () => {})
    store.saveStep("ses_1", "msg_1", stepContext)
    store.saveRun("ses_1", runContext)
    await flush()

    const restored = await createTraceStore(storage, () => {}).load("ses_1")
    expect(restored?.run).toEqual(runContext)
    expect(restored?.step?.spanContext).toEqual(stepContext)
  })

  test("ignores malformed or all-zero ids instead of building an invalid parent", async () => {
    const { storage, entries } = makeStorage()
    entries.set("chenryn.otel/tracing/1/ses_1", {
      run: { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 1 },
      step: { traceId: "not-hex", spanId: "c".repeat(16), traceFlags: 1, messageID: "msg_1" },
    })
    const store = createTraceStore(storage, () => {})
    expect(await store.load("ses_1")).toBeUndefined()
  })

  test("clear removes the stored key", async () => {
    const { storage, removed } = makeStorage()
    const store = createTraceStore(storage, () => {})
    store.saveRun("ses_1", runContext)
    await flush()
    await store.clear("ses_1")
    expect(removed).toEqual(["chenryn.otel/tracing/1/ses_1"])
    expect(await store.load("ses_1")).toBeUndefined()
  })

  test("storage failures are reported and never thrown", async () => {
    const errors: unknown[] = []
    const storage = {
      get: async () => { throw new Error("read boom") },
      set: async () => { throw new Error("write boom") },
      remove: async () => { throw new Error("remove boom") },
      scan: async () => ({ entries: [] }),
    } as never
    const store = createTraceStore(storage, (error) => errors.push(error))
    store.saveRun("ses_1", runContext)
    await flush()
    expect(await store.load("ses_1")).toBeUndefined()
    await store.clear("ses_1")
    expect(errors).toHaveLength(3)
  })
})
