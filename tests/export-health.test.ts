import { describe, test, expect } from "bun:test"
import { ExportResultCode, type ExportResult } from "@opentelemetry/core"
import { classifyExportError } from "../src/headers.ts"
import {
  createExportHealth,
  drainExportHealth,
  observeExporter,
  recordAuthRetry,
  recordDispatchError,
  recordExportFailure,
  recordFlush,
} from "../src/export-health.ts"
import { makeCtx } from "./helpers.ts"

describe("classifyExportError", () => {
  test("classifies authentication failures", () => {
    expect(classifyExportError(Object.assign(new Error("Unauthorized"), { statusCode: 401 }))).toBe("auth")
    expect(classifyExportError(Object.assign(new Error("DENIED"), { code: 16 }))).toBe("auth")
  })

  test("classifies transport failures", () => {
    expect(classifyExportError(Object.assign(new Error("Unavailable"), { code: 14 }))).toBe("unavailable")
    expect(classifyExportError(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))).toBe("unavailable")
    expect(classifyExportError(Object.assign(new Error("dns"), { code: "ENOTFOUND" }))).toBe("unavailable")
  })

  test("classifies timeouts", () => {
    expect(classifyExportError(Object.assign(new Error("Deadline"), { code: 4 }))).toBe("timeout")
    expect(classifyExportError(Object.assign(new Error("slow"), { code: "ETIMEDOUT" }))).toBe("timeout")
    expect(classifyExportError(new Error("Deadline exceeded"))).toBe("timeout")
  })

  test("falls back to other", () => {
    expect(classifyExportError(Object.assign(new Error("boom"), { status: 500 }))).toBe("other")
    expect(classifyExportError(undefined)).toBe("other")
  })
})

describe("drainExportHealth", () => {
  test("emits one point per key with bounded attributes", () => {
    const { ctx, counters, histograms } = makeCtx()
    const health = createExportHealth()
    recordExportFailure(health, "traces", Object.assign(new Error("x"), { code: 14 }))
    recordExportFailure(health, "traces", Object.assign(new Error("x"), { code: 14 }))
    recordAuthRetry(health, "logs")
    recordDispatchError(health, "session.step.started")
    recordFlush(health, false, 12)

    drainExportHealth(health, ctx.instruments, new Set(), { "project.id": "p" })

    expect(counters.exporterFailure.calls).toEqual([{
      value: 2,
      attrs: { "project.id": "p", signal: "traces", "error.type": "unavailable" },
    }])
    expect(counters.exporterAuthRetry.calls[0]).toEqual({ value: 1, attrs: { "project.id": "p", signal: "logs" } })
    expect(counters.eventDispatchError.calls[0]!.attrs["event.type"]).toBe("session.step.started")
    expect(counters.flushFailure.calls[0]!.value).toBe(1)
    expect(histograms.flushDuration.calls[0]!.value).toBe(12)
  })

  test("clears the buffer so the next drain emits nothing", () => {
    const { ctx, counters } = makeCtx()
    const health = createExportHealth()
    recordExportFailure(health, "metrics", new Error("boom"))
    drainExportHealth(health, ctx.instruments, new Set(), {})
    drainExportHealth(health, ctx.instruments, new Set(), {})
    expect(counters.exporterFailure.calls).toHaveLength(1)
    expect(health.failures.size).toBe(0)
  })

  test("respects disabled metrics", () => {
    const { ctx, counters } = makeCtx()
    const health = createExportHealth()
    recordExportFailure(health, "metrics", new Error("boom"))
    recordFlush(health, true, 3)
    drainExportHealth(health, ctx.instruments, new Set(["exporter.export.failures", "flush.duration"]), {})
    expect(counters.exporterFailure.calls).toHaveLength(0)
    expect(health.failures.size).toBe(0)
  })

  test("folds dispatch errors beyond the key cap into other", () => {
    const { ctx, counters } = makeCtx()
    const health = createExportHealth()
    for (let index = 0; index < 70; index += 1) recordDispatchError(health, `event.${index}`)
    drainExportHealth(health, ctx.instruments, new Set(), {})
    const keys = counters.eventDispatchError.calls.map((call) => call.attrs["event.type"])
    expect(keys).toContain("other")
    expect(new Set(keys).size).toBeLessThanOrEqual(64)
  })
})

describe("observeExporter", () => {
  class FakeExporter {
    readonly results: ExportResult[]
    calls = 0

    constructor(results: ExportResult[]) {
      this.results = results
    }

    export(_items: unknown, resultCallback: (result: ExportResult) => void): void {
      this.calls += 1
      resultCallback(this.results.shift() ?? { code: ExportResultCode.SUCCESS })
    }

    shutdown(): Promise<void> {
      return Promise.resolve()
    }
  }

  test("counts failed batches and preserves delegation", async () => {
    const health = createExportHealth()
    const exporter = new FakeExporter([{ code: ExportResultCode.FAILED, error: new Error("boom") }])
    const observed = observeExporter(exporter, "traces", health)

    expect(observed instanceof FakeExporter).toBe(true)
    await new Promise<ExportResult>((resolve) => observed.export([], resolve))
    expect(health.failures.get("traces\u0000other")).toBe(1)
    expect(exporter.calls).toBe(1)
  })

  test("ignores successful batches", async () => {
    const health = createExportHealth()
    const observed = observeExporter(new FakeExporter([{ code: ExportResultCode.SUCCESS }]), "logs", health)
    await new Promise<ExportResult>((resolve) => observed.export([], resolve))
    expect(health.failures.size).toBe(0)
  })
})
