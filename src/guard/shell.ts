// otel.guard — P0 shallow shell analysis (deep AST parse is P1).
// Cheap, bounded, synchronous: base64/unicode obfuscation detection, atom splitting,
// dangerous-op classification. Every regex is capped to avoid pathological input.

const B64_RE = /[A-Za-z0-9+/]{32,}={0,2}/
const B64_DECODE_CALL = /\bbase64\b[^|;&]*(-d|--decode)|openssl\s+enc\s+-d/i
const UNICODE_ESCAPE = /\\u[0-9a-fA-F]{4}/
const HEX_BLOB = /\\x[0-9a-fA-F]{2}(\\x[0-9a-fA-F]{2}){12,}/

// Injection / hidden-instruction signals ported from the AGT SDK's MCP scanner
// (mcp.js, MIT): only the literal pattern tables are taken — typosquatting and
// rug-pull heuristics are intentionally omitted (no tool-description input at
// the permission.evaluate decision point, and they carry a high false-positive rate).
/** Prompt-injection phrases that should not appear in tool arguments. */
const INJECTION_PATTERNS: ReadonlyArray<RegExp> = [
  /<system>/i, /ignore previous/i, /you must/i, /disregard/i, /override/i,
  /forget (all|your|previous)/i, /new instructions/i, /act as/i,
]
/** Zero-width / invisible code points used to hide instructions. Exported for prompt-injection scanning. */
export const ZERO_WIDTH_CHARS: ReadonlyArray<string> = [
  "\u200B", "\u200C", "\u200D", "\uFEFF", "\u00AD", "\u2060", "\u180E",
]
/** Cyrillic / Greek lookalikes for Latin letters (homoglyph attacks). Exported for prompt-injection scanning. */
export const HOMOGLYPHS: Readonly<Record<string, string>> = {
  "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p", "\u0441": "c",
  "\u0443": "y", "\u0445": "x", "\u0456": "i", "\u0458": "j",
  "\u03B1": "a", "\u03BF": "o", "\u03C1": "p",
}

const DANGEROUS: ReadonlyArray<{ op: string; re: RegExp }> = [
  { op: "delete", re: /\brm\b|\brmdir\b|\bshred\b|\bmkfs\b|\bdd\b[^|]*of=\/dev\//i },
  { op: "network", re: /\bcurl\b|\bwget\b|\bnc\b|\bncat\b|\bscp\b|\brsync\b.*@/i },
  { op: "privilege", re: /\bsudo\b|\bsu\b|\bchmod\s+777\b|\bchown\b|\bkill\b|\bpkill\b/i },
  { op: "overwrite", re: />\s*\/(?:dev|etc|usr|bin|sbin)\b/ },
  { op: "eval", re: /\beval\b|\bbash\s+-c\b|\bsh\s+-c\b|\bpython3?\s+-c\b|\bnode\s+-e\b/i },
  { op: "git_destructive", re: /\bgit\s+(push\s+--force|reset\s+--hard|clean\s+-[a-z]*f|filter-branch|filter-repo)/i },
]

const MAX_INPUT = 8192 // guard against pathological commands
const MAX_ATOMS = 16

/** Common build-artifact directory names that are safe targets for recursive delete. */
const SAFE_CLEANUP_TARGETS: ReadonlySet<string> = new Set([
  "node_modules", "dist", "build", ".next", "target", "__pycache__",
  ".pytest_cache", ".venv", "venv", "coverage", ".turbo", "out",
])
/** Recognized rm short flags (combined forms like -rf are split into characters). */
const RM_SHORT_FLAGS: ReadonlySet<string> = new Set(["r", "R", "f", "d", "v", "i", "I", "w", "W", "P"])
/** Long rm flags that do not take a separate value. */
const RM_LONG_FLAGS: ReadonlySet<string> = new Set([
  "recursive", "force", "dir", "verbose", "interactive", "one-file-system",
  "no-preserve-root", "preserve-root",
])

/** Tokenize a command into shell words, respecting single/double quotes (no escapes). */
export function tokenizeShellCommands(command: string): string[] {
  const s = command.slice(0, MAX_INPUT)
  const words: string[] = []
  let cur = ""
  let quote: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? ""
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === "'" || c === '"') { quote = c; continue }
    if (/\s/.test(c)) {
      if (cur) { words.push(cur); cur = "" }
      continue
    }
    cur += c
  }
  if (cur) words.push(cur)
  return words
}

/**
 * Return true only for a single `rm` invocation whose every target is a known
 * build-artifact directory name. Used to reduce false-positive `delete` signals;
 * it never relaxes an enforcement decision, only annotates the event.
 */
export function isSafeCleanupCommand(command: string): boolean {
  const words = tokenizeShellCommands(command)
  if (words.length < 2) return false
  // Skip leading env assignments / sudo.
  let idx = 0
  while (idx < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[idx]!) || words[idx] === "sudo")) idx++
  if (words[idx] !== "rm") return false

  let optionsEnded = false
  const targets: string[] = []
  for (const token of words.slice(idx + 1)) {
    if (optionsEnded) { targets.push(token); continue }
    if (token === "--") { optionsEnded = true; continue }
    if (token.startsWith("--")) {
      if (!RM_LONG_FLAGS.has(token.slice(2))) return false
      continue
    }
    if (token.startsWith("-")) {
      if (![...token.slice(1)].every((f) => RM_SHORT_FLAGS.has(f))) return false
      continue
    }
    targets.push(token)
  }
  if (!targets.length) return false
  return targets.every((target) => SAFE_CLEANUP_TARGETS.has(target.replace(/\/+$/, "").split("/").pop() ?? ""))
}

/** Split a shell command into coarse atoms on pipe / && / || / ; (quote-aware). */
export function splitAtoms(command: string): string[] {
  const s = command.slice(0, MAX_INPUT)
  const atoms: string[] = []
  let cur = ""
  let quote: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? ""
    if (quote) {
      cur += c
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
      continue
    }
    if (c === "|" || c === ";" || (c === "&" && s[i + 1] === "&")) {
      atoms.push(cur.trim())
      cur = ""
      if (c === "&") i++ // skip second &
      continue
    }
    cur += c
  }
  atoms.push(cur.trim())
  const out = atoms.filter(Boolean)
  return out.length > MAX_ATOMS ? out.slice(0, MAX_ATOMS) : out
}

export type ShellAnalysis = {
  obfuscated: boolean
  atoms_count: number
  dangerous_ops: string[]
  atoms: string[]
  /** Injection phrases found in the command (matched pattern sources). */
  injection_patterns: string[]
  /** Whether a zero-width / invisible code point is present. */
  zero_width: boolean
  /** Whether a Cyrillic/Greek homoglyph of a Latin letter is present. */
  homoglyph: boolean
  /** A single rm invocation targeting only known build artifacts. */
  safe_cleanup: boolean
}

const EMPTY_ANALYSIS: ShellAnalysis = {
  obfuscated: false, atoms_count: 0, dangerous_ops: [], atoms: [],
  injection_patterns: [], zero_width: false, homoglyph: false, safe_cleanup: false,
}

export function analyzeShell(command: string): ShellAnalysis {
  if (typeof command !== "string" || !command.trim()) return EMPTY_ANALYSIS
  const s = command.slice(0, MAX_INPUT)
  const atoms = splitAtoms(s)
  const obfuscated = (B64_RE.test(s) && B64_DECODE_CALL.test(s)) || HEX_BLOB.test(s) || UNICODE_ESCAPE.test(s)
  const ops = new Set<string>()
  for (const atom of atoms) {
    for (const d of DANGEROUS) {
      if (d.re.test(atom)) ops.add(d.op)
    }
  }
  const injectionPatterns = INJECTION_PATTERNS.filter((re) => re.test(s)).map((re) => re.source)
  const zeroWidth = ZERO_WIDTH_CHARS.some((ch) => s.includes(ch))
  const homoglyph = [...s].some((ch) => Object.hasOwn(HOMOGLYPHS, ch))
  return {
    obfuscated,
    atoms_count: atoms.length,
    dangerous_ops: [...ops],
    atoms,
    injection_patterns: injectionPatterns,
    zero_width: zeroWidth,
    homoglyph,
    safe_cleanup: isSafeCleanupCommand(s),
  }
}

/** Shell-ish permission actions the command extractor recognises. */
const SHELL_ACTIONS = new Set(["shell", "bash", "zsh"])

/** Pick the shell-ish command text out of a permission evaluation, if any. */
export function extractCommand(event: { action?: string; resources?: ReadonlyArray<unknown> }): string | null {
  const action = String(event?.action ?? "").toLowerCase()
  if (!SHELL_ACTIONS.has(action)) return null
  const r0 = event?.resources?.[0]
  return typeof r0 === "string" ? r0 : null
}
