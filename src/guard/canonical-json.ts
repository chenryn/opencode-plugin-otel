// otel.guard — RFC 8785 (JCS) canonical JSON serializer.
// Ported from microsoft/agent-governance-toolkit lib/audit.mjs (MIT).
// Zero third-party dependencies. Used to make version_sha256 and audit hashes
// independent of property insertion order.

/** Options for {@link canonicalJson}. */
export type CanonicalJsonOptions = {
  /** Lenient mode follows JSON.stringify semantics (drops undefined, maps non-finite to null). */
  lenient?: boolean
  /** Maximum nesting depth before throwing. Default 64. */
  maxDepth?: number
}

/**
 * Serialize a value so that equal data always produces equal bytes.
 * Keys are sorted by UTF-16 code unit (RFC 8785 ordering); the string is built
 * directly rather than by rebuilding an object, because JS reorders integer-like keys.
 * Strict mode refuses anything JSON cannot represent; lenient mode follows JSON.stringify.
 */
export function canonicalJson(value: unknown, options: CanonicalJsonOptions = {}): string | undefined {
  return serializeCanonical(value, options.lenient ?? false, options.maxDepth ?? 64, 0, new Set<object>())
}

function serializeCanonical(
  value: unknown,
  lenient: boolean,
  maxDepth: number,
  depth: number,
  ancestors: Set<object>,
): string | undefined {
  if (depth > maxDepth) throw new TypeError("canonicalJson: maximum depth exceeded")
  if (value === null) return "null"

  const type = typeof value
  if (type === "boolean") return value ? "true" : "false"
  if (type === "number") {
    const n = value as number
    if (!Number.isFinite(n)) {
      if (lenient) return "null"
      throw new TypeError("canonicalJson: non-finite number is not serializable")
    }
    return JSON.stringify(n)
  }
  if (type === "string") return JSON.stringify(value)
  if (type === "bigint") throw new TypeError("canonicalJson: bigint is not serializable")
  if (type === "undefined" || type === "function" || type === "symbol") {
    if (lenient) return undefined
    throw new TypeError(`canonicalJson: ${type} is not serializable`)
  }

  const obj = value as object
  if (typeof (obj as { toJSON?: unknown }).toJSON === "function") {
    return serializeCanonical((obj as { toJSON: () => unknown }).toJSON(), lenient, maxDepth, depth, ancestors)
  }
  if (ancestors.has(obj)) throw new TypeError("canonicalJson: circular reference")
  ancestors.add(obj)
  try {
    if (Array.isArray(obj)) {
      const items = obj.map((item) => {
        const serialized = serializeCanonical(item, lenient, maxDepth, depth + 1, ancestors)
        return serialized === undefined ? "null" : serialized
      })
      return `[${items.join(",")}]`
    }
    if (!lenient && !isPlainObject(obj)) throw new TypeError("canonicalJson: only plain objects are serializable")
    const parts: string[] = []
    for (const key of Object.keys(obj).sort()) {
      const serialized = serializeCanonical((obj as Record<string, unknown>)[key], lenient, maxDepth, depth + 1, ancestors)
      if (serialized !== undefined) parts.push(`${JSON.stringify(key)}:${serialized}`)
    }
    return `{${parts.join(",")}}`
  } finally {
    ancestors.delete(obj)
  }
}

function isPlainObject(value: object): boolean {
  if (Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
