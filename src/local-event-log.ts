/**
 * Optional local mirror of outgoing log events.
 *
 * Every record handed to `LoggerProvider.emit` is also appended to a JSON Lines
 * file, so operators can inspect exactly what the plugin would have sent without
 * depending on the backend's ingestion. One JSON object per line; the resource
 * attributes the SDK attaches are included for context.
 *
 * Best-effort by design: the first write failure disables the mirror, and no
 * error ever reaches the export path.
 */
import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs"
import { dirname } from "node:path"

/** A single mirrored log event, shaped like the OTLP LogRecord the SDK builds. */
export type LocalEventLogEntry = {
  /** Record time as ISO-8601 (the OTLP `timeUnixNano` source). */
  time: string
  /** Observed time as ISO-8601, when the caller supplied one. */
  observedTime?: string
  severityNumber?: number
  severityText?: string
  body: string
  traceId?: string
  spanId?: string
  attributes: Record<string, unknown>
  /** `service.name`, `app.version`, and any configured resource attributes. */
  resource: Record<string, unknown>
}

/** Normalises the three accepted timestamp shapes to epoch milliseconds. */
export function toEpochMillis(input: unknown): number | undefined {
  if (typeof input === "number" && Number.isFinite(input)) return input
  if (input instanceof Date) return input.getTime()
  if (Array.isArray(input) && input.length === 2) {
    const [seconds, nanos] = input as [number, number]
    return seconds * 1000 + Math.round(nanos / 1e6)
  }
  return undefined
}

export type LocalEventLog = { append(entry: LocalEventLogEntry): void }

/**
 * Creates an append-only JSONL writer for the given path.
 *
 * The parent directory is created on first write. If the directory or file is not
 * writable the writer goes quiet after one attempt instead of retrying per event.
 */
export function createLocalEventLog(path: string): LocalEventLog {
  let ready = false
  let disabled = false
  return {
    append(entry: LocalEventLogEntry) {
      if (disabled) return
      try {
        if (!ready) {
          mkdirSync(dirname(path), { recursive: true })
          // create with owner-only permissions before the first append: the mirror
          // can contain prompts, commands, and tool output
          closeSync(openSync(path, "a", 0o600))
          ready = true
        }
        appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8")
      } catch {
        disabled = true
      }
    },
  }
}
