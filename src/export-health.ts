import { ExportResultCode, type ExportResult } from "@opentelemetry/core"
import type { Attributes } from "@opentelemetry/api"
import type { Instruments } from "./types.ts"
import { classifyExportError, type ExportSignal } from "./headers.ts"

/** Largest number of distinct event types tracked between flushes. */
const MAX_DISPATCH_KEYS = 64

/**
 * Buffered export-health counters. Nothing is recorded on a successful export, so an outage
 * cannot amplify the metric stream; buffered values are drained once per scheduled flush and
 * cleared, which bounds self-monitoring to at most one data point per key per flush.
 */
export type ExportHealth = {
  failures: Map<string, number>
  authRetries: Map<ExportSignal, number>
  dispatchErrors: Map<string, number>
  flushCount: number
  flushFailures: number
  flushDurationMs: number
}

/** Creates an empty export-health buffer. */
export function createExportHealth(): ExportHealth {
  return {
    failures: new Map(),
    authRetries: new Map(),
    dispatchErrors: new Map(),
    flushCount: 0,
    flushFailures: 0,
    flushDurationMs: 0,
  }
}

function bump<K>(map: Map<K, number>, key: K, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by)
}

/** Records one failed export batch for `signal`, classified by cause. */
export function recordExportFailure(health: ExportHealth, signal: ExportSignal, error: unknown): void {
  bump(health.failures, `${signal}\u0000${classifyExportError(error)}`)
}

/** Records one header refresh triggered by an authentication failure. */
export function recordAuthRetry(health: ExportHealth, signal: ExportSignal): void {
  bump(health.authRetries, signal)
}

/** Records one event-dispatch failure, folding unknown types into `other`. */
export function recordDispatchError(health: ExportHealth, eventType: string): void {
  const key = health.dispatchErrors.has(eventType) || health.dispatchErrors.size < MAX_DISPATCH_KEYS - 1 ? eventType : "other"
  bump(health.dispatchErrors, key)
}

/** Records the outcome and duration of one scheduled flush. */
export function recordFlush(health: ExportHealth, ok: boolean, durationMs: number): void {
  health.flushCount += 1
  if (!ok) health.flushFailures += 1
  health.flushDurationMs += durationMs
}

/**
 * Emits buffered export-health counters and clears the buffer. Values are emitted as a single
 * increment per key, so a backend sees one data point per flush regardless of export volume.
 */
export function drainExportHealth(
  health: ExportHealth,
  instruments: Instruments,
  disabledMetrics: ReadonlySet<string>,
  commonAttrs: Attributes,
): void {
  const enabled = (name: string) => !disabledMetrics.has(name)
  if (enabled("exporter.export.failures")) {
    for (const [key, count] of health.failures) {
      const [signal, errorType] = key.split("\u0000")
      instruments.exporterFailureCounter.add(count, {
        ...commonAttrs,
        signal: signal!,
        "error.type": errorType!,
      })
    }
  }
  if (enabled("exporter.auth.retry.count")) {
    for (const [signal, count] of health.authRetries) {
      instruments.exporterAuthRetryCounter.add(count, { ...commonAttrs, signal })
    }
  }
  if (enabled("event.dispatch.errors")) {
    for (const [eventType, count] of health.dispatchErrors) {
      instruments.eventDispatchErrorCounter.add(count, { ...commonAttrs, "event.type": eventType })
    }
  }
  if (health.flushCount > 0 && enabled("flush.duration")) {
    instruments.flushDurationHistogram.record(health.flushDurationMs / health.flushCount, commonAttrs)
  }
  if (health.flushFailures > 0 && enabled("flush.failures")) {
    instruments.flushFailureCounter.add(health.flushFailures, commonAttrs)
  }
  health.failures.clear()
  health.authRetries.clear()
  health.dispatchErrors.clear()
  health.flushCount = 0
  health.flushFailures = 0
  health.flushDurationMs = 0
}

type ObservableExporter = {
  export(items: unknown, resultCallback: (result: ExportResult) => void): void
}

/**
 * Wraps any exporter so failed batches are counted without changing its type: the wrapper
 * delegates through the prototype chain, so `instanceof` checks and delegation helpers on the
 * original exporter keep working.
 */
export function observeExporter<T extends object>(exporter: T, signal: ExportSignal, health: ExportHealth): T {
  const wrapped = Object.create(exporter) as T & ObservableExporter
  wrapped.export = (items, resultCallback) => {
    ;(exporter as unknown as ObservableExporter).export(items, (result) => {
      if (result.code === ExportResultCode.FAILED) recordExportFailure(health, signal, result.error)
      resultCallback(result)
    })
  }
  return wrapped
}
