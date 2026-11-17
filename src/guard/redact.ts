// otel.guard — conservative tool-output secret redaction.
//
// Only well-known credential shapes are replaced; no heuristics on arbitrary
// text. The audit/telemetry layer records matched pattern ids, never the secret
// values. This module is pure so it can be unit-tested without an OTel runtime.

/** A recognized credential shape with a stable id for telemetry. */
export type SecretPattern = {
  id: string
  source: string
  flags: string
}

/** Result of scanning or redacting one text value. */
export type RedactionResult = {
  text: string
  matches: string[]
  truncated: boolean
}

/** Max characters scanned per text value (protects against pathological output). */
const MAX_SCAN_CHARS = 1024 * 1024

/** Well-known secret shapes, mirroring the AGT OpenCode redaction set. */
export const SECRET_PATTERNS: ReadonlyArray<SecretPattern> = [
  { id: "aws_access_key", source: "AKIA[0-9A-Z]{16}", flags: "g" },
  { id: "github_pat", source: "gh[pousr]_[A-Za-z0-9_]{36,255}", flags: "g" },
  { id: "openai_key", source: "sk-[A-Za-z0-9_-]{20,}", flags: "g" },
  { id: "jwt", source: "eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}", flags: "g" },
  {
    id: "pem_private_key",
    source: "-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\\s\\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
    flags: "g",
  },
  { id: "azure_storage_key", source: "AccountKey=[A-Za-z0-9+/=]{40,}", flags: "g" },
]

function compile(): Array<{ id: string; re: RegExp }> {
  return SECRET_PATTERNS.map((p) => ({ id: p.id, re: new RegExp(p.source, p.flags) }))
}

/** Scan text for known secrets without modifying it. */
export function scanSecrets(text: string): string[] {
  if (typeof text !== "string" || !text.length) return []
  const value = text.slice(0, MAX_SCAN_CHARS)
  const matches = new Set<string>()
  for (const { id, re } of compile()) {
    re.lastIndex = 0
    if (re.test(value)) matches.add(id)
  }
  return [...matches]
}

/**
 * Replace known secrets in `text` with `[REDACTED:<id>]`. Returns the original
 * text unchanged when nothing matched; values beyond the scan bound are left
 * untouched and flagged via `truncated`.
 */
export function redactSecrets(text: string): RedactionResult {
  if (typeof text !== "string" || !text.length) return { text: "", matches: [], truncated: false }
  const truncated = text.length > MAX_SCAN_CHARS
  const head = truncated ? text.slice(0, MAX_SCAN_CHARS) : text
  let redacted = head
  const matches = new Set<string>()
  for (const { id, re } of compile()) {
    re.lastIndex = 0
    if (re.test(redacted)) {
      matches.add(id)
      re.lastIndex = 0
      redacted = redacted.replace(re, `[REDACTED:${id}]`)
    }
  }
  return { text: truncated ? redacted + text.slice(MAX_SCAN_CHARS) : redacted, matches: [...matches], truncated }
}

/** A text or file content part as carried by `Tool.Result.content`. */
export type ContentPart = { type: string; text?: string; [key: string]: unknown }

/**
 * Redact every text-bearing content part. Non-text parts and unknown keys are
 * preserved verbatim so tool output structure survives redaction.
 */
export function redactContent(content: string | ReadonlyArray<ContentPart> | undefined): {
  content: string | ContentPart[] | undefined
  matches: string[]
  truncated: boolean
} {
  if (content === undefined) return { content: undefined, matches: [], truncated: false }
  if (typeof content === "string") {
    const out = redactSecrets(content)
    return { content: out.text, matches: out.matches, truncated: out.truncated }
  }
  if (!Array.isArray(content)) return { content: content as ContentPart[] | undefined, matches: [], truncated: false }
  const matches = new Set<string>()
  let truncated = false
  const parts = content.map((part) => {
    if (!part || typeof part !== "object" || part.type !== "text" || typeof part.text !== "string") return part
    const out = redactSecrets(part.text)
    for (const id of out.matches) matches.add(id)
    truncated = truncated || out.truncated
    return { ...part, text: out.text }
  })
  return { content: parts, matches: [...matches], truncated }
}
