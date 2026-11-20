import { homedir } from "node:os"
import { join } from "node:path"
import { DEFAULT_SEMCONV, parseSemconv, SEMCONV_VALUES, type SemconvFlavor } from "./semconv.ts"
import { LEVELS, type Level } from "./types.ts"

/** Accepted values for `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`. */
export type MetricsTemporality = "cumulative" | "delta" | "lowmemory"

/** Valid trace types emitted by the plugin. */
export const TRACE_TYPES = ["session", "llm", "tool"] as const

/** Guard operating modes. `monitor_only` shadows (labels `would_denied`); `enforce` mutates effects. */
export type GuardModeOption = "monitor_only" | "enforce"

/** Guard failure semantics when the decision path itself throws. */
export type GuardFailModeOption = "fail_open" | "fail_closed"

/** Guard-specific resolved configuration. */
export type GuardConfig = {
  /** Master switch: register the `permission.evaluate` decision point. Default `false`. */
  guardEnabled: boolean
  /** Overrides the policy file `settings.mode` when provided. */
  guardMode: GuardModeOption | undefined
  /** Overrides the policy file `settings.fail_mode` when provided. */
  guardFailMode: GuardFailModeOption | undefined
  /** Path to the JSON policy file (S3 rule page export format). */
  guardPolicyPath: string
  /** Whether unmatched evaluations still emit a `passthrough` policy.decision event. */
  guardEmitUnmatched: boolean
  /** Opt-in hash-chained audit log of decisions. Default `false`. */
  guardAuditEnabled: boolean
  /** Path to the hash-chained audit log. */
  guardAuditPath: string
  /** Operator-declared principal subject; env-only, never from tool args or model output. */
  guardPrincipalSub: string | undefined
  /** Optional principal issuer; env-only. */
  guardPrincipalIss: string | undefined
  /** HMAC key for argument digests (>=32 bytes); env-only. */
  guardAuditHmacKey: string | undefined
  /** Opt-in prompt defense coverage scoring. Default `false`. */
  guardPromptDefense: boolean
  /** Minimum acceptable grade (A/B/C/D/F); reports below this can fail closed. */
  guardPromptDefenseMinGrade: string
  /** When true, append the 10 governance context lines to event.system before scoring. Default `false`. */
  guardPromptDefenseInjectContext: boolean
  /** Master switch for the `tool.execute.before` / `execute.after` hooks. Default `false`. */
  guardToolHooks: boolean
  /** Path to the optional positive command/URL allowlist JSON file. */
  guardToolAllowlistPath: string
  /** Redact known credential patterns from tool output before the model sees it. Default `false`. */
  guardToolRedact: boolean
  /** Opt-in user-prompt injection blocking on `session.prompt`. Default `false` (advisory scan only when the hook is on). */
  guardPromptInjectionBlock: boolean
  /** Minimum injection severity that blocks when `guardPromptInjectionBlock` + enforce. Default `high`. */
  guardPromptInjectionMinSeverity: "critical" | "high" | "medium"
}

const VALID_TEMPORALITIES: ReadonlySet<MetricsTemporality> = new Set<MetricsTemporality>(["cumulative", "delta", "lowmemory"])
const TRACE_DISABLE_ALL_VALUES = new Set(["all", "*", "true", "1"])

/** Configuration values resolved from `OPENCODE_*` environment variables. */
export type PluginConfig = {
  enabled: boolean
  logsEnabled: boolean
  capturePromptInLogs: boolean
  captureModelContext: boolean
  /** Attach the full model-visible context (system, messages, tool definitions) to the LLM span. */
  captureContextSnapshot: boolean
  /** Emit factual tool metadata (verbatim command, file paths); independent of content capture. */
  captureToolFacts: boolean
  /** Emit log events that duplicate a span; the `gen_ai` flavor suppresses them when false. */
  emitRedundantEvents: boolean
  /** Mirror every emitted log event to a local JSONL file. Default `true`. */
  localEventLog: boolean
  /** Destination of the mirrored log events. */
  localEventLogPath: string
  logLevel: string | undefined
  endpoint: string
  protocol: "grpc" | "http/protobuf" | "http/json"
  metricsInterval: number
  logsInterval: number
  metricPrefix: string
  otlpHeaders: string | undefined
  otlpHeadersHelper: string | undefined
  resourceAttributes: string | undefined
  spanAttributes: string | undefined
  traceparent: string | undefined
  tracestate: string | undefined
  metricsTemporality: MetricsTemporality | undefined
  semconv: SemconvFlavor
  /** Agent runtime version recorded as `gen_ai.agent.version`; falls back to the app version. */
  agentVersion: string | undefined
  disabledMetrics: Set<string>
  disabledTraces: Set<string>
  tracePropagationProviders: Set<string>
  guard: GuardConfig
}

export function parseAttributePairs(raw: string | undefined): Record<string, string> {
  const attrs: Record<string, string> = {}
  if (!raw) return attrs

  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=")
    if (idx <= 0) continue
    const key = pair.slice(0, idx).trim()
    const value = pair.slice(idx + 1).trim()
    if (!key) continue
    attrs[key] = value
  }

  return attrs
}

/**
 * Options accepted via the OpenCode V2 plugin object form
 * (`{ "package": "opencode-plugin-otel", "options": { ... } }`). Every field is optional; a provided
 * value takes precedence over the matching `OPENCODE_*` environment variable,
 * which in turn wins over the built-in default. Field names mirror the resolved
 * {@link PluginConfig}.
 */
export type OtelPluginOptions = {
  enabled?: boolean
  logsEnabled?: boolean
  capturePromptInLogs?: boolean
  captureModelContext?: boolean
  /** Attach the full model-visible context (system, messages, tool definitions) to the LLM span. */
  captureContextSnapshot?: boolean
  captureToolFacts?: boolean
  emitRedundantEvents?: boolean
  /** Mirror emitted log events to a local JSONL file. Default `true`. */
  localEventLog?: boolean
  /** Local JSONL path for the mirrored log events. */
  localEventLogPath?: string
  logLevel?: string
  endpoint?: string
  protocol?: "grpc" | "http/protobuf" | "http/json"
  metricsInterval?: number
  logsInterval?: number
  metricPrefix?: string
  otlpHeaders?: string
  otlpHeadersHelper?: string
  resourceAttributes?: string
  spanAttributes?: string
  traceparent?: string
  tracestate?: string
  metricsTemporality?: MetricsTemporality
  semconv?: SemconvFlavor
  /** Agent runtime version; `OPENCODE_AGENT_VERSION` overrides the app version. */
  agentVersion?: string
  disabledMetrics?: string[]
  disabledTraces?: string[]
  tracePropagationProviders?: string[]
  /** Enables the otel.guard runtime guard (permission.evaluate decision point). Default `false`. */
  guardEnabled?: boolean
  /** Overrides the policy file mode: `monitor_only` (shadow) or `enforce`. */
  guardMode?: GuardModeOption
  /** Overrides the policy file fail mode: `fail_open` or `fail_closed`. */
  guardFailMode?: GuardFailModeOption
  /** Path to the guard policy JSON file. */
  guardPolicyPath?: string
  /** Emit `passthrough` policy.decision events for unmatched evaluations. Default `true`. */
  guardEmitUnmatched?: boolean
  /** Enable the hash-chained decision audit log. Default `false`. */
  guardAuditEnabled?: boolean
  /** Path to the hash-chained audit log. */
  guardAuditPath?: string
  /** Enable prompt defense coverage scoring. Default `false`. */
  guardPromptDefense?: boolean
  /** Minimum acceptable grade (A/B/C/D/F). Default `B`. */
  guardPromptDefenseMinGrade?: string
  /** Inject the 10 governance context lines into the system prompt before scoring. Default `false`. */
  guardPromptDefenseInjectContext?: boolean
  /** Enable the tool.execute.before/after hooks (structured args, output redaction, failure audit). Default `false`. */
  guardToolHooks?: boolean
  /** Path to the positive command/URL allowlist JSON file. */
  guardToolAllowlistPath?: string
  /** Redact well-known credentials from tool output before it reaches the model. Default `false`. */
  guardToolRedact?: boolean
  /** Scan user prompts for injection and (with enforce) block them. Default `false`. */
  guardPromptInjectionBlock?: boolean
  /** Minimum injection severity to block: `critical`/`high`/`medium`. Default `high`. */
  guardPromptInjectionMinSeverity?: "critical" | "high" | "medium"
  /** Principal subject is env-only (OPENCODE_GUARD_PRINCIPAL_SUB) and intentionally absent here. */
}

const VALID_PROTOCOLS = new Set<PluginConfig["protocol"]>(["grpc", "http/protobuf", "http/json"])

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function pickBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function pickPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function pickStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === "string")
}

function pickProtocol(value: unknown): PluginConfig["protocol"] | undefined {
  return typeof value === "string" && VALID_PROTOCOLS.has(value as PluginConfig["protocol"])
    ? (value as PluginConfig["protocol"])
    : undefined
}

function pickMetricsTemporality(value: unknown): MetricsTemporality | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.toLowerCase()
  return VALID_TEMPORALITIES.has(normalized as MetricsTemporality) ? (normalized as MetricsTemporality) : undefined
}

function pickGuardMode(value: unknown): GuardModeOption | undefined {
  return value === "monitor_only" || value === "enforce" ? value : undefined
}

function pickGuardFailMode(value: unknown): GuardFailModeOption | undefined {
  return value === "fail_open" || value === "fail_closed" ? value : undefined
}

function pickInjectionSeverity(value: unknown): "critical" | "high" | "medium" | undefined {
  return value === "critical" || value === "high" || value === "medium" ? value : undefined
}

function pickSemconv(value: unknown): SemconvFlavor | undefined {
  return typeof value === "string" ? parseSemconv(value) : undefined
}

/** Parses a positive integer from an environment variable, returning `fallback` if absent or invalid. */
export function parseEnvInt(key: string, fallback: number): number {
  const raw = process.env[key]
  if (!raw) return fallback
  if (!/^[1-9]\d*$/.test(raw)) return fallback
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : fallback
}

/** Returns `true` when the environment variable is present and non-empty. */
function hasNonEmptyEnv(key: string): boolean {
  return !!process.env[key]
}

const DISABLED_ENV_VALUES = new Set(["0", "false", "no", "off"])

/**
 * Reads an opt-out boolean environment variable. Unset or empty values fall back to
 * `fallback`; common false spellings disable the behavior and anything else enables it.
 */
function readEnvBoolean(key: string, fallback: boolean): boolean {
  const raw = process.env[key]
  if (!raw) return fallback
  return !DISABLED_ENV_VALUES.has(raw.trim().toLowerCase())
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map(s => s.trim()).filter(Boolean)
}

function normalizeList(values: string[]): string[] {
  return values.map(s => s.trim()).filter(Boolean)
}

/** Builds the disabled-traces set from raw values, expanding global values like `all` to every trace type. */
function expandDisabledTraces(values: string[]): Set<string> {
  const normalized = values.map(v => v.trim().toLowerCase()).filter(Boolean)
  if (normalized.some(value => TRACE_DISABLE_ALL_VALUES.has(value))) {
    return new Set(TRACE_TYPES)
  }
  return new Set(normalized)
}

/**
 * Resolves the plugin config from plugin `options` and `OPENCODE_*` environment
 * variables. For every field a provided option wins over the environment
 * variable, which in turn wins over the built-in default.
 *
 * Copies resource attributes and metrics temporality into the corresponding
 * OTel environment variables. OTLP headers are passed directly to exporters.
 */
export function loadConfig(options: OtelPluginOptions = {}): PluginConfig {
  const resolvedOptions = typeof options === "object" && options !== null ? options : {}
  const otlpHeaders = pickString(resolvedOptions.otlpHeaders) ?? process.env["OPENCODE_OTLP_HEADERS"]
  const otlpHeadersHelper = pickString(resolvedOptions.otlpHeadersHelper) ?? process.env["OPENCODE_OTLP_HEADERS_HELPER"]
  const resourceAttributes = pickString(resolvedOptions.resourceAttributes) ?? process.env["OPENCODE_RESOURCE_ATTRIBUTES"]
  const spanAttributes = pickString(resolvedOptions.spanAttributes) ?? process.env["OPENCODE_SPAN_ATTRIBUTES"]
  const traceparent = pickString(resolvedOptions.traceparent) ?? process.env["OPENCODE_TRACEPARENT"]
  const tracestate = pickString(resolvedOptions.tracestate) ?? process.env["OPENCODE_TRACESTATE"]
  const optionMetricsTemporality = pickMetricsTemporality(resolvedOptions.metricsTemporality)
  const envMetricsTemporality = pickMetricsTemporality(process.env["OPENCODE_OTLP_METRICS_TEMPORALITY"])
  const metricsTemporality = optionMetricsTemporality ?? envMetricsTemporality
  const protocol = pickProtocol(resolvedOptions.protocol)
    ?? pickProtocol(process.env["OPENCODE_OTLP_PROTOCOL"])
    ?? "grpc"

  if (
    optionMetricsTemporality === undefined
    && envMetricsTemporality === undefined
    && pickString(process.env["OPENCODE_OTLP_METRICS_TEMPORALITY"])
  ) {
    console.warn(
      `[opencode-plugin-otel] Invalid metrics temporality "${process.env["OPENCODE_OTLP_METRICS_TEMPORALITY"]}". ` +
        `Expected one of: cumulative, delta, lowmemory. Value ignored.`,
    )
  }

  if (metricsTemporality) process.env["OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"] = metricsTemporality

  const optionSemconv = pickSemconv(resolvedOptions.semconv)
  const rawEnvSemconv = pickString(process.env["OPENCODE_SEMCONV"])
  const envSemconv = parseSemconv(rawEnvSemconv)
  const semconv = optionSemconv ?? envSemconv ?? DEFAULT_SEMCONV

  if (typeof resolvedOptions.semconv === "string" && !optionSemconv) {
    console.warn(
      `[opencode-plugin-otel] Invalid semconv option "${resolvedOptions.semconv}". ` +
        `Expected one of: ${SEMCONV_VALUES}. Value ignored.`,
    )
  }
  if (rawEnvSemconv && !envSemconv) {
    console.warn(
      `[opencode-plugin-otel] Invalid OPENCODE_SEMCONV "${rawEnvSemconv}". ` +
        `Expected one of: ${SEMCONV_VALUES}. Value ignored.`,
    )
  }

  if (resourceAttributes) process.env["OTEL_RESOURCE_ATTRIBUTES"] = resourceAttributes

  const optionMetrics = pickStringList(resolvedOptions.disabledMetrics)
  const disabledMetrics = new Set(
    optionMetrics ? normalizeList(optionMetrics) : splitList(process.env["OPENCODE_DISABLE_METRICS"]),
  )

  const optionTraces = pickStringList(resolvedOptions.disabledTraces)
  const disabledTraces = expandDisabledTraces(optionTraces ?? splitList(process.env["OPENCODE_DISABLE_TRACES"]))

  const optionTracePropagationProviders = pickStringList(resolvedOptions.tracePropagationProviders)
  const tracePropagationProviders = new Set(
    optionTracePropagationProviders
      ? normalizeList(optionTracePropagationProviders)
      : splitList(process.env["OPENCODE_TRACE_PROPAGATION_PROVIDERS"]),
  )

  const optionGuardMode = pickGuardMode(resolvedOptions.guardMode) ?? pickGuardMode(process.env["OPENCODE_GUARD_MODE"])
  const optionGuardFailMode = pickGuardFailMode(resolvedOptions.guardFailMode)
    ?? pickGuardFailMode(process.env["OPENCODE_GUARD_FAIL_MODE"])
  const guardPolicyPath = pickString(resolvedOptions.guardPolicyPath)
    ?? process.env["OPENCODE_GUARD_POLICY_PATH"]
    ?? join(homedir(), ".config", "opencode", "otel-guard-policy.json")
  const optionGuardEmitUnmatched = pickBoolean(resolvedOptions.guardEmitUnmatched)
    ?? readEnvBoolean("OPENCODE_GUARD_EMIT_UNMATCHED", true)
  const guardAuditEnabled = pickBoolean(resolvedOptions.guardAuditEnabled)
    ?? hasNonEmptyEnv("OPENCODE_GUARD_AUDIT_ENABLED")
  const rawMinGrade = (pickString(resolvedOptions.guardPromptDefenseMinGrade)
    ?? process.env["OPENCODE_GUARD_PROMPT_DEFENSE_MIN_GRADE"] ?? "B").toUpperCase()
  const guardPromptDefenseMinGrade = ["A", "B", "C", "D", "F"].includes(rawMinGrade) ? rawMinGrade : "B"
  const guard: GuardConfig = {
    guardEnabled: pickBoolean(resolvedOptions.guardEnabled) ?? hasNonEmptyEnv("OPENCODE_GUARD_ENABLED"),
    guardMode: optionGuardMode,
    guardFailMode: optionGuardFailMode,
    guardPolicyPath,
    guardEmitUnmatched: optionGuardEmitUnmatched,
    guardAuditEnabled,
    guardAuditPath: pickString(resolvedOptions.guardAuditPath)
      ?? process.env["OPENCODE_GUARD_AUDIT_PATH"]
      ?? join(homedir(), ".config", "opencode", "otel-guard-audit.json"),
    guardPrincipalSub: pickString(process.env["OPENCODE_GUARD_PRINCIPAL_SUB"]),
    guardPrincipalIss: pickString(process.env["OPENCODE_GUARD_PRINCIPAL_ISS"]),
    guardAuditHmacKey: pickString(process.env["OPENCODE_GUARD_AUDIT_HMAC_KEY"]),
    guardPromptDefense: pickBoolean(resolvedOptions.guardPromptDefense)
      ?? hasNonEmptyEnv("OPENCODE_GUARD_PROMPT_DEFENSE"),
    guardPromptDefenseMinGrade,
    guardPromptDefenseInjectContext: pickBoolean(resolvedOptions.guardPromptDefenseInjectContext)
      ?? hasNonEmptyEnv("OPENCODE_GUARD_PROMPT_DEFENSE_INJECT"),
    guardToolHooks: pickBoolean(resolvedOptions.guardToolHooks)
      ?? hasNonEmptyEnv("OPENCODE_GUARD_TOOL_HOOKS"),
    guardToolAllowlistPath: pickString(resolvedOptions.guardToolAllowlistPath)
      ?? process.env["OPENCODE_GUARD_TOOL_ALLOWLIST_PATH"]
      ?? join(homedir(), ".config", "opencode", "otel-guard-tool-allowlist.json"),
    guardToolRedact: pickBoolean(resolvedOptions.guardToolRedact)
      ?? hasNonEmptyEnv("OPENCODE_GUARD_TOOL_REDACT"),
    guardPromptInjectionBlock: pickBoolean(resolvedOptions.guardPromptInjectionBlock)
      ?? hasNonEmptyEnv("OPENCODE_GUARD_PROMPT_INJECTION_BLOCK"),
    guardPromptInjectionMinSeverity: pickInjectionSeverity(resolvedOptions.guardPromptInjectionMinSeverity)
      ?? (resolvedOptions.guardPromptInjectionMinSeverity !== undefined
        ? "high" // explicit but invalid option must not silently fall through to env
        : pickInjectionSeverity(process.env["OPENCODE_GUARD_PROMPT_INJECTION_MIN_SEVERITY"]) ?? "high"),
  }

  return {
    enabled: pickBoolean(resolvedOptions.enabled) ?? hasNonEmptyEnv("OPENCODE_ENABLE_TELEMETRY"),
    logsEnabled: pickBoolean(resolvedOptions.logsEnabled) ?? !hasNonEmptyEnv("OPENCODE_DISABLE_LOGS"),
    capturePromptInLogs: pickBoolean(resolvedOptions.capturePromptInLogs) ?? hasNonEmptyEnv("OPENCODE_CAPTURE_PROMPT_IN_LOGS"),
    captureModelContext: pickBoolean(resolvedOptions.captureModelContext) ?? hasNonEmptyEnv("OPENCODE_CAPTURE_MODEL_CONTEXT"),
    captureContextSnapshot: pickBoolean(resolvedOptions.captureContextSnapshot)
      ?? hasNonEmptyEnv("OPENCODE_CAPTURE_CONTEXT_SNAPSHOT"),
    captureToolFacts: pickBoolean(resolvedOptions.captureToolFacts)
      ?? readEnvBoolean("OPENCODE_CAPTURE_TOOL_FACTS", true),
    emitRedundantEvents: pickBoolean(resolvedOptions.emitRedundantEvents)
      ?? readEnvBoolean("OPENCODE_EMIT_REDUNDANT_EVENTS", true),
    localEventLog: pickBoolean(resolvedOptions.localEventLog)
      ?? readEnvBoolean("OPENCODE_LOCAL_EVENT_LOG", true),
    localEventLogPath: pickString(resolvedOptions.localEventLogPath)
      ?? process.env["OPENCODE_LOCAL_EVENT_LOG_PATH"]
      ?? join(homedir(), ".local", "share", "opencode", "otel-log-events.jsonl"),
    logLevel: pickString(resolvedOptions.logLevel),
    endpoint: pickString(resolvedOptions.endpoint) ?? process.env["OPENCODE_OTLP_ENDPOINT"] ?? "http://localhost:4317",
    protocol,
    metricsInterval: pickPositiveInt(resolvedOptions.metricsInterval) ?? parseEnvInt("OPENCODE_OTLP_METRICS_INTERVAL", 60000),
    logsInterval: pickPositiveInt(resolvedOptions.logsInterval) ?? parseEnvInt("OPENCODE_OTLP_LOGS_INTERVAL", 5000),
    metricPrefix: pickString(resolvedOptions.metricPrefix) ?? process.env["OPENCODE_METRIC_PREFIX"] ?? "opencode.",
    otlpHeaders,
    otlpHeadersHelper,
    resourceAttributes,
    spanAttributes,
    traceparent,
    tracestate,
    metricsTemporality,
    semconv,
    agentVersion: pickString(resolvedOptions.agentVersion) ?? pickString(process.env["OPENCODE_AGENT_VERSION"]),
    disabledMetrics,
    disabledTraces,
    tracePropagationProviders,
    guard,
  }
}

export function resolveHelperPath(
  helper: string | undefined,
  directory: string | undefined,
  worktree: string | undefined,
): string | undefined {
  if (!helper) return helper
  const projectRoot = worktree ?? directory ?? process.cwd()
  return helper
    .replaceAll("${PROJECT_ROOT}", projectRoot)
    .replaceAll("${WORKTREE}", worktree ?? projectRoot)
    .replaceAll("${DIRECTORY}", directory ?? projectRoot)
}

/**
 * Resolves an opencode log level string to a `Level`.
 * Returns `current` unchanged when the input does not match a known level.
 */
export function resolveLogLevel(logLevel: string, current: Level): Level {
  const candidate = logLevel.toLowerCase()
  if (candidate in LEVELS) return candidate as Level
  return current
}
