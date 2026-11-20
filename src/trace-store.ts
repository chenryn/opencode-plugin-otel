import { isSpanContextValid, type SpanContext } from "@opentelemetry/api"
import type { Plugin } from "@opencode/plugin"

type Storage = Plugin.Context["storage"]

/** Storage namespace for persisted W3C span contexts. Bump the suffix on a schema change. */
const STORAGE_PREFIX = "chenryn.otel/tracing/1"

/** Maximum number of sessions whose write-through state is remembered in memory. */
const MAX_WRITE_STATE = 512

const TRACE_ID_RE = /^(?!0{32}$)[0-9a-f]{32}$/
const SPAN_ID_RE = /^(?!0{16}$)[0-9a-f]{16}$/

type StoredSpanContext = { traceId: string; spanId: string; traceFlags: number }
type StoredTraceContext = {
  run?: StoredSpanContext
  step?: StoredSpanContext & { messageID: string }
}

/** Trace parentage persisted by a previous plugin instance for one session. */
export type RestoredTraceContext = {
  run?: SpanContext
  step?: { messageID: string; spanContext: SpanContext }
}

/** Persists and restores the trace context that survives a plugin instance replacement. */
export type TraceStore = {
  /** Reads the context stored for a session, if a previous instance persisted one. */
  load(sessionID: string): Promise<RestoredTraceContext | undefined>
  /** Write-throughs the run span context of the current execution. */
  saveRun(sessionID: string, spanContext: SpanContext): void
  /** Write-throughs the step span context together with its assistant message id. */
  saveStep(sessionID: string, messageID: string, spanContext: SpanContext): void
  /** Forgets the persisted context, so the next execution starts a new trace. */
  clear(sessionID: string): Promise<void>
}

function encode(spanContext: SpanContext): StoredSpanContext {
  return { traceId: spanContext.traceId, spanId: spanContext.spanId, traceFlags: spanContext.traceFlags }
}

function decode(value: unknown): SpanContext | undefined {
  if (!value || typeof value !== "object") return undefined
  const { traceId, spanId, traceFlags } = value as Record<string, unknown>
  if (typeof traceId !== "string" || typeof spanId !== "string" || typeof traceFlags !== "number") return undefined
  if (!TRACE_ID_RE.test(traceId) || !SPAN_ID_RE.test(spanId) || !Number.isInteger(traceFlags) || traceFlags < 0 || traceFlags > 255) {
    return undefined
  }
  const spanContext: SpanContext = { traceId, spanId, traceFlags }
  return isSpanContextValid(spanContext) ? spanContext : undefined
}

/**
 * Creates a store backed by the plugin storage API. Every write is best-effort: storage is a
 * convenience for cross-instance trace continuity and must never break telemetry dispatch.
 */
export function createTraceStore(storage: Storage, onError: (error: unknown) => void): TraceStore {
  const writeState = new Map<string, StoredTraceContext>()
  const key = (sessionID: string) => `${STORAGE_PREFIX}/${sessionID}`

  const write = (sessionID: string, next: StoredTraceContext) => {
    if (!writeState.has(sessionID) && writeState.size >= MAX_WRITE_STATE) {
      const oldest = writeState.keys().next().value
      if (oldest !== undefined) writeState.delete(oldest)
    }
    writeState.set(sessionID, next)
    void storage.set(key(sessionID), next).catch(onError)
  }

  return {
    async load(sessionID) {
      try {
        const stored = await storage.get(key(sessionID))
        if (!stored || typeof stored !== "object" || Array.isArray(stored)) return undefined
        const record = stored as StoredTraceContext
        const run = decode(record.run)
        const step = decode(record.step)
        const messageID = record.step?.messageID
        if (!run && !step) return undefined
        writeState.set(sessionID, {
          ...(run ? { run: encode(run) } : {}),
          ...(step && typeof messageID === "string" ? { step: { ...encode(step), messageID } } : {}),
        })
        return {
          ...(run ? { run } : {}),
          ...(step && typeof messageID === "string" ? { step: { messageID, spanContext: step } } : {}),
        }
      } catch (error) {
        onError(error)
        return undefined
      }
    },

    saveRun(sessionID, spanContext) {
      const current = writeState.get(sessionID) ?? {}
      const next: StoredTraceContext = { ...current, run: encode(spanContext) }
      if (current.run?.traceId === next.run?.traceId && current.run?.spanId === next.run?.spanId) return
      write(sessionID, next)
    },

    saveStep(sessionID, messageID, spanContext) {
      const current = writeState.get(sessionID) ?? {}
      const next: StoredTraceContext = { ...current, step: { ...encode(spanContext), messageID } }
      if (current.step?.traceId === next.step?.traceId && current.step?.spanId === next.step?.spanId
        && current.step?.messageID === messageID) {
        return
      }
      write(sessionID, next)
    },

    async clear(sessionID) {
      writeState.delete(sessionID)
      try {
        await storage.remove(key(sessionID))
      } catch (error) {
        onError(error)
      }
    },
  }
}
