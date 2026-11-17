// otel.guard — user-prompt injection detection.
//
// Distinct from `prompt-defense.ts`: that module scores the DEFENSIVE coverage
// of a system prompt (how many guardrail instructions it contains) and is
// advisory-only. This module scans USER input for ATTACK signatures and can be
// wired to block. Measuring defense coverage on a user prompt is wrong — normal
// requests score 0/12 and would all be denied — so blocking uses this detector
// instead. Patterns are deliberately specific to avoid false positives.

import { createHash } from "node:crypto"
import { HOMOGLYPHS, ZERO_WIDTH_CHARS } from "./shell.ts"

/** Severity of one injection finding. */
export type InjectionSeverity = "critical" | "high" | "medium"

/** A single injection attack signature. */
export type InjectionPattern = {
  id: string
  severity: InjectionSeverity
  source: string
  flags: string
}

/** One matched signature in a scan report. */
export type InjectionFinding = {
  id: string
  severity: InjectionSeverity
}

/** Result of scanning a user prompt for injection signatures. */
export type InjectionReport = {
  detected: boolean
  findings: InjectionFinding[]
  highestSeverity: InjectionSeverity | null
  zeroWidth: boolean
  homoglyph: boolean
  promptHash: string
}

/** Upper bound on the text scanned. */
const MAX_PROMPT_CHARS = 100_000

/**
 * Attack signatures. Each is a specific exploit shape, not a generic word:
 * "ignore previous instructions" is an attack, a bare "ignore" is not.
 */
export const INJECTION_PATTERNS: ReadonlyArray<InjectionPattern> = [
  {
    id: "instruction-override", severity: "critical",
    source: "(?:ignore|disregard|forget|override)\\s+(?:all\\s+|any\\s+)?(?:the\\s+)?(?:previous|prior|above|earlier|preceding|your|system|original)\\s+(?:instruction|prompt|rule|directive|message)",
    flags: "i",
  },
  {
    id: "instruction-override-zh", severity: "critical",
    source: "(?:忽略|无视|忘掉|忘记|覆盖)\\s*(?:(?:之前|前面|以上|上面|所有|全部|你的|原先|先前|系统|的)\\s*){0,3}(?:指令|指示|规则|提示词|提示|命令|要求)",
    flags: "i",
  },
  {
    id: "role-takeover", severity: "high",
    source: "(?:you are now|act as|pretend to be|switch to|enter)\\s+(?:a\\s+|the\\s+)?(?:dan|jailbreak|unrestricted|unfiltered|developer mode|evil|admin|root|god mode)",
    flags: "i",
  },
  {
    id: "system-tag-injection", severity: "high",
    source: "<\\|?\\s*(?:system|sys)\\s*\\|?>|\\[/?\\s*system\\s*\\]|\\[\\[\\s*system\\s*\\]\\]|<<\\s*sys\\s*>>",
    flags: "i",
  },
  {
    id: "fake-role-header", severity: "high",
    source: "^\\s*(?:system|assistant)\\s*:",
    flags: "im",
  },
  {
    id: "prompt-leak", severity: "high",
    source: "(?:reveal|show|print|repeat|display|output|dump|tell me|recite)\\s+(?:me\\s+)?(?:your|the|full|complete|hidden|original|exact|system|developer)?\\s*(?:system|developer|hidden|initial|internal)?\\s*(?:prompt|instruction|message|directive)",
    flags: "i",
  },
  {
    id: "prompt-leak-zh", severity: "high",
    source: "(?:泄露|透露|显示|输出|打印|重复|告诉我|念出)\\s*(?:你的|完整的|隐藏的|内部的|原始的|系统)?\\s*(?:系统|开发者|内部)?\\s*(?:提示词|提示|指令|规则|系统消息)",
    flags: "i",
  },
  {
    id: "jailbreak", severity: "critical",
    source: "(?:jailbreak|dan mode|developer mode|god mode|sudo mode|unrestricted mode|bypass (?:the |your )?(?:guardrail|safety|restriction|filter)|no (?:restriction|limit|filter|guardrail|rules))",
    flags: "i",
  },
  {
    id: "instruction-override-hint", severity: "medium",
    source: "(?:new instructions|override the rules|do not follow the (?:rules|instructions)|disregard everything)",
    flags: "i",
  },
]

/** Severity precedence for computing the highest finding. */
const SEVERITY_RANK: Readonly<Record<InjectionSeverity, number>> = { critical: 3, high: 2, medium: 1 }

/**
 * Scan a user prompt for injection signatures. Never throws on normal text.
 * Hash is computed for correlation only; the prompt text itself is never
 * returned or logged by callers.
 */
export function scanPromptInjection(prompt: string): InjectionReport {
  if (typeof prompt !== "string" || !prompt.length) {
    return { detected: false, findings: [], highestSeverity: null, zeroWidth: false, homoglyph: false, promptHash: "" }
  }
  const value = prompt.slice(0, MAX_PROMPT_CHARS)
  const findings: InjectionFinding[] = []
  for (const pattern of INJECTION_PATTERNS) {
    let re: RegExp
    try {
      re = new RegExp(pattern.source, pattern.flags)
    } catch {
      continue // a malformed pattern must never break scanning
    }
    if (re.test(value)) findings.push({ id: pattern.id, severity: pattern.severity })
  }
  const zeroWidth = ZERO_WIDTH_CHARS.some((ch) => value.includes(ch))
  const homoglyph = [...value].some((ch) => Object.hasOwn(HOMOGLYPHS, ch))
  let highestSeverity: InjectionSeverity | null = null
  for (const finding of findings) {
    if (!highestSeverity || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[highestSeverity]) {
      highestSeverity = finding.severity
    }
  }
  return {
    detected: findings.length > 0 || zeroWidth || homoglyph,
    findings,
    highestSeverity,
    zeroWidth,
    homoglyph,
    promptHash: createHash("sha256").update(prompt, "utf8").digest("hex"),
  }
}

/**
 * Whether a report should block at the given minimum severity. Zero-width and
 * homoglyph-only findings have no severity and are treated as medium — they are
 * obfuscation signals, not definitive attacks, so advisory mode can include
 * them without the false positives a hard block would cause.
 */
export function isInjectionBlocking(
  report: InjectionReport,
  minSeverity: InjectionSeverity = "high",
): boolean {
  if (!report.detected) return false
  if (report.highestSeverity && SEVERITY_RANK[report.highestSeverity] >= SEVERITY_RANK[minSeverity]) return true
  return (report.zeroWidth || report.homoglyph) && SEVERITY_RANK["medium"] >= SEVERITY_RANK[minSeverity]
}
