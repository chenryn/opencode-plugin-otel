import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ExportResultCode, type ExportResult } from "@opentelemetry/core"
import { DynamicHeaders, isAuthFailure, parseOtlpHeaders, RefreshingSpanExporter } from "../src/headers.ts"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

class FakeSpanExporter implements SpanExporter {
  readonly calls: string[][] = []
  readonly shutdowns: string[][]

  constructor(
    private readonly headers: Record<string, string>,
    private readonly results: ExportResult[],
    shutdowns: string[][],
  ) {
    this.shutdowns = shutdowns
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.calls.push(Object.keys(this.headers).sort())
    resultCallback(this.results.shift() ?? { code: ExportResultCode.SUCCESS })
  }

  shutdown(): Promise<void> {
    this.shutdowns.push(Object.keys(this.headers).sort())
    return Promise.resolve()
  }
}

describe("parseOtlpHeaders", () => {
  test("parses comma-separated key value pairs", () => {
    expect(parseOtlpHeaders("Authorization=Bearer a, x-api-key = b=c ")).toEqual({
      Authorization: "Bearer a",
      "x-api-key": "b=c",
    })
  })

  test("ignores empty and malformed segments", () => {
    expect(parseOtlpHeaders("good=value,bad,no-key=, trailing=value,")).toEqual({
      good: "value",
      "no-key": "",
      trailing: "value",
    })
  })
})

describe("isAuthFailure", () => {
  test("matches HTTP auth status codes", () => {
    expect(isAuthFailure(Object.assign(new Error("Unauthorized"), { statusCode: 401 }))).toBe(true)
    expect(isAuthFailure(Object.assign(new Error("Forbidden"), { status: 403 }))).toBe(true)
  })

  test("matches gRPC auth status codes", () => {
    expect(isAuthFailure(Object.assign(new Error("UNAUTHENTICATED"), { code: 16 }))).toBe(true)
    expect(isAuthFailure(Object.assign(new Error("PERMISSION_DENIED"), { code: 7 }))).toBe(true)
  })

  test("does not match unrelated failures", () => {
    expect(isAuthFailure(Object.assign(new Error("Unavailable"), { code: 14 }))).toBe(false)
  })
})

describe("DynamicHeaders", () => {
  test("merges helper headers over static headers", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "otel-headers-"))
    const helper = join(tempDir, "helper.sh")
    await Bun.write(helper, "#!/bin/sh\nprintf '%s' '{\"Authorization\":\"Bearer dynamic\",\"x-extra\":\"1\"}'\n")
    await Bun.spawn(["chmod", "+x", helper]).exited

    const headers = new DynamicHeaders({ Authorization: "Bearer static", static: "1" }, helper)
    await expect(headers.refresh()).resolves.toBe(1)
    expect(headers.current()).toEqual({ Authorization: "Bearer dynamic", static: "1", "x-extra": "1" })
  })

  test("shares one in-flight helper refresh", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "otel-headers-"))
    const countFile = join(tempDir, "count")
    const helper = join(tempDir, "helper.sh")
    await Bun.write(helper, `#!/bin/sh\ncount=$(cat "${countFile}" 2>/dev/null || printf 0)\ncount=$((count + 1))\nprintf '%s' "$count" > "${countFile}"\nsleep 0.1\nprintf '%s' '{"Authorization":"Bearer dynamic"}'\n`)
    await Bun.spawn(["chmod", "+x", helper]).exited

    const headers = new DynamicHeaders({}, helper)
    await Promise.all([headers.refresh(), headers.refresh(), headers.refresh()])
    expect(await Bun.file(countFile).text()).toBe("1")
  })

  test("fails helper refresh when the helper times out", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "otel-headers-"))
    const helper = join(tempDir, "helper.sh")
    await Bun.write(helper, "#!/bin/sh\nsleep 1\n")
    await Bun.spawn(["chmod", "+x", helper]).exited

    const headers = new DynamicHeaders({}, helper, 50)
    await expect(headers.refresh()).rejects.toThrow("OTLP headers helper was terminated")
  })
})

describe("RefreshingSpanExporter", () => {
  test("refreshes headers and retries once after auth failure", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "otel-headers-"))
    const helper = join(tempDir, "helper.sh")
    await Bun.write(helper, "#!/bin/sh\nprintf '%s' '{\"Authorization\":\"Bearer dynamic\"}'\n")
    await Bun.spawn(["chmod", "+x", helper]).exited

    const dynamicHeaders = new DynamicHeaders({ Authorization: "Bearer static" }, helper)
    const shutdowns: string[][] = []
    const results = [
      { code: ExportResultCode.FAILED, error: Object.assign(new Error("Unauthorized"), { statusCode: 401 }) },
      { code: ExportResultCode.SUCCESS },
    ]
    const seenHeaders: Record<string, string>[] = []
    const exporter = new RefreshingSpanExporter((headers) => {
      seenHeaders.push(headers)
      return new FakeSpanExporter(headers, results, shutdowns)
    }, dynamicHeaders)

    const result = await new Promise<ExportResult>((resolve) => exporter.export([], resolve))
    expect(result.code).toBe(ExportResultCode.SUCCESS)
    expect(seenHeaders).toEqual([{ Authorization: "Bearer static" }, { Authorization: "Bearer dynamic" }])
    expect(shutdowns).toEqual([["Authorization"]])
  })
})

describe("export observer", () => {
  test("reports a failed batch and the auth retry", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "otel-headers-"))
    const helper = join(tempDir, "helper.sh")
    await Bun.write(helper, "#!/bin/sh\nprintf '%s' '{\"Authorization\":\"Bearer dynamic\"}'\n")
    await Bun.spawn(["chmod", "+x", helper]).exited

    const dynamicHeaders = new DynamicHeaders({ Authorization: "Bearer static" }, helper)
    const shutdowns: string[][] = []
    const results = [
      { code: ExportResultCode.FAILED, error: Object.assign(new Error("Unauthorized"), { statusCode: 401 }) },
      { code: ExportResultCode.SUCCESS },
    ]
    const failures: string[] = []
    const retries: string[] = []
    const exporter = new RefreshingSpanExporter(
      (headers) => new FakeSpanExporter(headers, results, shutdowns),
      dynamicHeaders,
      { failure: (signal) => failures.push(signal), authRetry: (signal) => retries.push(signal) },
    )

    const result = await new Promise<ExportResult>((resolve) => exporter.export([], resolve))
    expect(result.code).toBe(ExportResultCode.SUCCESS)
    expect(failures).toEqual(["traces"])
    expect(retries).toEqual(["traces"])
  })

  test("reports a retried export that fails again", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "otel-headers-"))
    const helper = join(tempDir, "helper.sh")
    await Bun.write(helper, "#!/bin/sh\nprintf '%s' '{\"Authorization\":\"Bearer dynamic\"}'\n")
    await Bun.spawn(["chmod", "+x", helper]).exited

    const dynamicHeaders = new DynamicHeaders({ Authorization: "Bearer static" }, helper)
    const shutdowns: string[][] = []
    const results = [
      { code: ExportResultCode.FAILED, error: Object.assign(new Error("Unauthorized"), { statusCode: 401 }) },
      { code: ExportResultCode.FAILED, error: new Error("boom") },
    ]
    const failures: string[] = []
    const exporter = new RefreshingSpanExporter(
      (headers) => new FakeSpanExporter(headers, results, shutdowns),
      dynamicHeaders,
      { failure: (signal) => failures.push(signal) },
    )

    const result = await new Promise<ExportResult>((resolve) => exporter.export([], resolve))
    expect(result.code).toBe(ExportResultCode.FAILED)
    expect(failures).toEqual(["traces", "traces"])
  })
})
