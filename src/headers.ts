import { createRequire } from "module"
import { ExportResultCode, type ExportResult } from "@opentelemetry/core"
import type { PushMetricExporter, ResourceMetrics } from "@opentelemetry/sdk-metrics"
import type { SpanExporter, ReadableSpan } from "@opentelemetry/sdk-trace-base"
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs"
import type { Metadata } from "@grpc/grpc-js"

const require = createRequire(import.meta.url)
const DEFAULT_HELPER_TIMEOUT_MS = 5000

type Exporter<T> = {
  export(items: T, resultCallback: (result: ExportResult) => void): void
  shutdown(): Promise<void>
  forceFlush?(): Promise<void>
}

type SelectAggregation = NonNullable<PushMetricExporter["selectAggregation"]>
type SelectAggregationTemporality = NonNullable<PushMetricExporter["selectAggregationTemporality"]>

export type HeadersMap = Record<string, string>

/** OTLP signal an export belongs to, used for low-cardinality self-monitoring attributes. */
export type ExportSignal = "traces" | "metrics" | "logs"

/** Cause of an export failure, grouped so dashboards never key on a message string. */
export type ExportErrorType = "auth" | "unavailable" | "timeout" | "other"

/** Observer notified about export outcomes; implemented by the buffered health counters. */
export type ExportObserver = {
  failure?(signal: ExportSignal, error: unknown): void
  authRetry?(signal: ExportSignal): void
}

/**
 * Classifies an export error into a bounded set of causes. Authentication wins over transport
 * classification so a 401 from a proxy is still reported as `auth`.
 */
export function classifyExportError(error: unknown): ExportErrorType {
  if (isAuthFailure(error)) return "auth"
  const err = error as Record<string, unknown> | undefined
  const numericStatus = Number(err?.["status"] ?? err?.["statusCode"] ?? err?.["code"])
  if ([14, 4].includes(numericStatus) || err?.["code"] === "ECONNREFUSED" || err?.["code"] === "ENOTFOUND") {
    return numericStatus === 4 ? "timeout" : "unavailable"
  }
  if (err?.["code"] === "ETIMEDOUT") return "timeout"
  const message = error instanceof Error ? error.message : String(error ?? "")
  return /deadline|timed? ?out/i.test(message) ? "timeout" : "other"
}

export function parseOtlpHeaders(raw: string | undefined): HeadersMap {
  if (!raw) return {}
  const headers: HeadersMap = {}
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=")
    if (idx > 0) {
      const key = pair.slice(0, idx).trim()
      const val = pair.slice(idx + 1).trim()
      if (key) headers[key] = val
    }
  }
  return headers
}

export function createGrpcMetadata(headers: HeadersMap): Metadata {
  const { Metadata } = require("@grpc/grpc-js") as typeof import("@grpc/grpc-js")
  const metadata = new Metadata()
  for (const [key, value] of Object.entries(headers)) metadata.set(key, value)
  return metadata
}

export function isAuthFailure(error: unknown): boolean {
  if (!error) return false
  const err = error as Record<string, unknown>
  const numericStatus = Number(err["status"] ?? err["statusCode"] ?? err["code"])
  if ([401, 403, 7, 16].includes(numericStatus)) return true
  const message = error instanceof Error ? error.message : String(error)
  return /\b(401|403)\b|unauthenticated|permission denied|unauthorized|forbidden/i.test(message)
}

export class DynamicHeaders {
  private headers: HeadersMap
  private version = 0
  private refreshPromise: Promise<number> | undefined

  constructor(
    private readonly staticHeaders: HeadersMap,
    private readonly helper: string | undefined,
    private readonly helperTimeoutMs = DEFAULT_HELPER_TIMEOUT_MS,
  ) {
    this.headers = { ...staticHeaders }
  }

  current(): HeadersMap {
    return { ...this.headers }
  }

  currentVersion(): number {
    return this.version
  }

  refresh(): Promise<number> {
    if (!this.helper) return Promise.resolve(this.version)
    if (!this.refreshPromise) {
      this.refreshPromise = this.runHelper()
        .then((helperHeaders) => {
          const next = { ...this.staticHeaders, ...helperHeaders }
          const changed = headerSignature(next) !== headerSignature(this.headers)
          this.headers = next
          if (changed) this.version += 1
          return this.version
        })
        .finally(() => {
          this.refreshPromise = undefined
        })
    }
    return this.refreshPromise
  }

  private async runHelper(): Promise<HeadersMap> {
    const proc = Bun.spawn([this.helper!], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: this.helperTimeoutMs,
      killSignal: "SIGTERM",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (proc.signalCode) {
      throw new Error(`OTLP headers helper was terminated by ${proc.signalCode}`)
    }
    if (exitCode !== 0) {
      const detail = stderr.trim() || `exit code ${exitCode}`
      throw new Error(`OTLP headers helper failed: ${detail}`)
    }
    const parsed = JSON.parse(stdout) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("OTLP headers helper must return a JSON object")
    }
    const headers: HeadersMap = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") throw new Error(`OTLP headers helper returned non-string value for ${key}`)
      headers[key] = value
    }
    return headers
  }
}

export class RefreshingMetricExporter implements PushMetricExporter {
  private exporter: PushMetricExporter
  private headersVersion: number

  constructor(
    private readonly createExporter: (headers: HeadersMap) => PushMetricExporter,
    private readonly dynamicHeaders: DynamicHeaders,
    private readonly observer?: ExportObserver,
  ) {
    this.exporter = createExporter(dynamicHeaders.current())
    this.headersVersion = dynamicHeaders.currentVersion()
  }

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    exportWithAuthRetry(this, metrics, resultCallback, "metrics", this.observer)
  }

  forceFlush(): Promise<void> {
    return this.exporter.forceFlush()
  }

  shutdown(): Promise<void> {
    return this.exporter.shutdown()
  }

  selectAggregationTemporality(
    instrumentType: Parameters<SelectAggregationTemporality>[0],
  ): ReturnType<SelectAggregationTemporality> {
    return this.exporter.selectAggregationTemporality!(instrumentType)
  }

  selectAggregation(instrumentType: Parameters<SelectAggregation>[0]): ReturnType<SelectAggregation> {
    return this.exporter.selectAggregation!(instrumentType)
  }

  _exporter(): PushMetricExporter {
    return this.exporter
  }

  _replaceExporter(version: number): void {
    const old = this.exporter
    this.exporter = this.createExporter(this.dynamicHeaders.current())
    this.headersVersion = version
    old.shutdown().catch(() => {})
  }

  _refreshHeaders(): Promise<number> {
    return this.dynamicHeaders.refresh()
  }

  _headersVersion(): number {
    return this.headersVersion
  }
}

export class RefreshingSpanExporter implements SpanExporter {
  private exporter: SpanExporter
  private headersVersion: number

  constructor(
    private readonly createExporter: (headers: HeadersMap) => SpanExporter,
    private readonly dynamicHeaders: DynamicHeaders,
    private readonly observer?: ExportObserver,
  ) {
    this.exporter = createExporter(dynamicHeaders.current())
    this.headersVersion = dynamicHeaders.currentVersion()
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    exportWithAuthRetry(this, spans, resultCallback, "traces", this.observer)
  }

  forceFlush(): Promise<void> {
    return this.exporter.forceFlush?.() ?? Promise.resolve()
  }

  shutdown(): Promise<void> {
    return this.exporter.shutdown()
  }

  _exporter(): SpanExporter {
    return this.exporter
  }

  _replaceExporter(version: number): void {
    const old = this.exporter
    this.exporter = this.createExporter(this.dynamicHeaders.current())
    this.headersVersion = version
    old.shutdown().catch(() => {})
  }

  _refreshHeaders(): Promise<number> {
    return this.dynamicHeaders.refresh()
  }

  _headersVersion(): number {
    return this.headersVersion
  }
}

export class RefreshingLogExporter implements LogRecordExporter {
  private exporter: LogRecordExporter
  private headersVersion: number

  constructor(
    private readonly createExporter: (headers: HeadersMap) => LogRecordExporter,
    private readonly dynamicHeaders: DynamicHeaders,
    private readonly observer?: ExportObserver,
  ) {
    this.exporter = createExporter(dynamicHeaders.current())
    this.headersVersion = dynamicHeaders.currentVersion()
  }

  export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    exportWithAuthRetry(this, logs, resultCallback, "logs", this.observer)
  }

  shutdown(): Promise<void> {
    return this.exporter.shutdown()
  }

  _exporter(): LogRecordExporter {
    return this.exporter
  }

  _replaceExporter(version: number): void {
    const old = this.exporter
    this.exporter = this.createExporter(this.dynamicHeaders.current())
    this.headersVersion = version
    old.shutdown().catch(() => {})
  }

  _refreshHeaders(): Promise<number> {
    return this.dynamicHeaders.refresh()
  }

  _headersVersion(): number {
    return this.headersVersion
  }
}

function exportWithAuthRetry<T>(
  wrapper: {
    _exporter(): Exporter<T>
    _replaceExporter(version: number): void
    _refreshHeaders(): Promise<number>
    _headersVersion(): number
  },
  items: T,
  resultCallback: (result: ExportResult) => void,
  signal: ExportSignal,
  observer?: ExportObserver,
): void {
  const finish = (result: ExportResult) => {
    if (result.code === ExportResultCode.FAILED) observer?.failure?.(signal, result.error)
    resultCallback(result)
  }
  wrapper._exporter().export(items, (result) => {
    if (result.code !== ExportResultCode.FAILED || !isAuthFailure(result.error)) {
      finish(result)
      return
    }
    observer?.failure?.(signal, result.error)
    observer?.authRetry?.(signal)
    wrapper._refreshHeaders()
      .then((version) => {
        if (version !== wrapper._headersVersion()) wrapper._replaceExporter(version)
        wrapper._exporter().export(items, finish)
      })
      .catch((error: unknown) => {
        resultCallback({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) })
      })
  })
}

function headerSignature(headers: HeadersMap): string {
  return JSON.stringify(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)))
}
