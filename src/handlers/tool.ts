import { SeverityNumber } from "@opentelemetry/api-logs"
import { SpanKind, SpanStatusCode } from "@opentelemetry/api"
import type { EventOf, HandlerContext, ToolFacts, ToolMeta } from "../types.ts"
import { GEN_AI_METRIC, OPENCODE_ATTR, errorAttrs, signalAttrs, toolCallAttrs, toolDurationAttrs, toolEndAttrs, toolFactsAttrs, toolSpanName, toolStartAttrs } from "../semconv.ts"
import { exitCodeOf, hashJson, sha256Hex, toolSemantics, toolSemanticsAttrs } from "../facts.ts"
import {
  currentTurnID,
  errorSummary,
  getSessionAgentMeta,
  isMetricEnabled,
  isTraceEnabled,
  recordFirstToken,
  resolveStepContext,
  setBoundedMap,
  type StructuredError,
} from "../util.ts"

const GIT_COMMIT_RE = /\bgit\s+commit(?![-\w])/
const SHELL_TOOL_RE = /(^|\.)(bash|shell)$/i

type FileToolSpec = {
  operation: string
  /** Argument keys holding a single path, tried in order. */
  keys: string[]
  /** Argument keys holding a list of edits/patches, each with its own path. */
  many?: string[]
}

const FILE_TOOL_PATH_KEYS = ["path", "filePath", "file_path"]

const FILE_TOOL_SPEC: Readonly<Record<string, FileToolSpec>> = {
  read: { operation: "read", keys: FILE_TOOL_PATH_KEYS },
  view: { operation: "read", keys: FILE_TOOL_PATH_KEYS },
  write: { operation: "write", keys: FILE_TOOL_PATH_KEYS },
  create: { operation: "write", keys: FILE_TOOL_PATH_KEYS },
  edit: { operation: "edit", keys: FILE_TOOL_PATH_KEYS },
  multiedit: { operation: "edit", keys: FILE_TOOL_PATH_KEYS, many: ["edits", "files"] },
  patch: { operation: "edit", keys: FILE_TOOL_PATH_KEYS, many: ["patches", "edits", "files"] },
  apply_patch: { operation: "edit", keys: [], many: ["patches", "files"] },
  list: { operation: "list", keys: FILE_TOOL_PATH_KEYS },
  ls: { operation: "list", keys: FILE_TOOL_PATH_KEYS },
  glob: { operation: "glob", keys: [] },
  grep: { operation: "search", keys: FILE_TOOL_PATH_KEYS },
  search: { operation: "search", keys: FILE_TOOL_PATH_KEYS },
}

/**
 * Derives factual metadata from tool arguments: the verbatim shell command, or the operation
 * and paths of a file tool. Returns `undefined` when the tool carries neither, so no empty
 * attribute is ever written.
 */
export function toolFacts(tool: string, input: Record<string, unknown>): ToolFacts | undefined {
  const facts: ToolFacts = {}
  const name = tool.toLowerCase().split(".").at(-1) ?? tool.toLowerCase()
  const spec = FILE_TOOL_SPEC[name]
  if (spec) {
    facts.operation = spec.operation
    const paths = collectPaths(input, spec)
    if (paths.length) facts.paths = paths
  }
  if (SHELL_TOOL_RE.test(tool) && typeof input["command"] === "string" && input["command"]) {
    facts.command = input["command"]
  }
  return facts.operation || facts.command ? facts : undefined
}

function collectPaths(input: Record<string, unknown>, spec: FileToolSpec): string[] {
  const paths: string[] = []
  for (const key of spec.keys) {
    const value = input[key]
    if (typeof value === "string" && value) {
      paths.push(value)
      break
    }
  }
  for (const key of spec.many ?? []) {
    const list = input[key]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (typeof entry === "string") {
        if (entry) paths.push(entry)
        continue
      }
      if (!entry || typeof entry !== "object") continue
      for (const pathKey of FILE_TOOL_PATH_KEYS) {
        const value = (entry as Record<string, unknown>)[pathKey]
        if (typeof value === "string" && value) {
          paths.push(value)
          break
        }
      }
    }
  }
  return [...new Set(paths)]
}

type ToolContent = { type: "text"; text: string } | { type: "file"; uri: string; mime: string; name?: string }

/** Records the tool name for correlation with its execution and terminal events. */
export function handleToolInputStarted(e: EventOf<"session.tool.input.started">, ctx: HandlerContext) {
  const d = e.data
  recordFirstToken(d.assistantMessageID, e.created, ctx)
  const turnID = ctx.tracing.stepMeta.get(d.assistantMessageID)?.turnID ?? currentTurnID(d.sessionID, ctx)
  setBoundedMap(ctx.tracing.toolMeta, d.id, {
    sessionID: d.sessionID,
    assistantMessageID: d.assistantMessageID,
    stepID: d.assistantMessageID,
    ...(turnID ? { turnID } : {}),
    tool: d.name,
    startMs: e.created,
  })
}

/** Starts timing and tracing an observed tool call, and retains the command for commit detection. */
export function handleToolCalled(e: EventOf<"session.tool.called">, ctx: HandlerContext) {
  const d = e.data
  const turnID = ctx.tracing.stepMeta.get(d.assistantMessageID)?.turnID ?? currentTurnID(d.sessionID, ctx)
  const meta: ToolMeta = ctx.tracing.toolMeta.get(d.id) ?? {
    sessionID: d.sessionID,
    assistantMessageID: d.assistantMessageID,
    stepID: d.assistantMessageID,
    ...(turnID ? { turnID } : {}),
    tool: "unknown",
    startMs: e.created,
  }
  const isSubagent = meta.tool === "subagent"
  const facts = ctx.captureToolFacts ? toolFacts(meta.tool, d.input) : undefined
  const argsHash = argsFingerprint(d.input)
  const semantics = toolSemantics(meta.tool, d.input)
  setBoundedMap(ctx.tracing.toolMeta, d.id, {
    ...meta,
    startMs: e.created,
    executionStarted: true,
    ...(isSubagent && typeof d.input["agent"] === "string" ? { agent: d.input["agent"] } : {}),
    ...(typeof d.input["command"] === "string" ? { command: d.input["command"] } : {}),
    ...(facts ? { toolFacts: facts } : {}),
    ...(argsHash ? { argsHash } : {}),
    ...(Object.keys(semantics).length ? { semantics } : {}),
  })

  if (!isTraceEnabled("tool", ctx)) return
  if (isSubagent) startSubagentSpan(d.id, ctx)
  else {
    const span = ctx.tracer.startSpan(
      toolSpanName(ctx.semconv, meta.tool, ctx.tracePrefix),
      {
        startTime: e.created,
        kind: SpanKind.INTERNAL,
        attributes: {
          ...toolStartAttrs(ctx.semconv, {
            sessionID: d.sessionID,
            tool: meta.tool,
            callID: d.id,
            ...(meta.turnID ? { turnID: meta.turnID } : {}),
            ...(meta.stepID ? { stepID: meta.stepID } : {}),
          }),
          ...ctx.commonAttrs,
        },
      },
      resolveStepContext(d.sessionID, d.assistantMessageID, ctx),
    )
    setBoundedMap(ctx.tracing.toolSpans, d.id, span)
    setBoundedMap(ctx.tracing.toolSpanContexts, d.id, span.spanContext())
  }

  const { agentName, agentType, agentVersion } = getSessionAgentMeta(d.sessionID, ctx)
  ctx.tracing.toolSpans.get(d.id)?.setAttributes(toolCallAttrs(ctx.semconv, {
    agent: agentName,
    agentType,
    agentVersion,
    inputJson: ctx.captureContent ? safeJson(d.input) : undefined,
    providerExecuted: isProviderExecuted(d),
    ...(facts ? { facts } : {}),
    ...(argsHash ? { argsHash } : {}),
    semantics,
  }))
}

type ProviderExecution = {
  readonly executed?: boolean
  readonly provider?: { readonly executed?: boolean }
}

function isProviderExecuted(data: ProviderExecution): boolean {
  return data.provider?.executed ?? data.executed ?? false
}

function startSubagentSpan(callID: string, ctx: HandlerContext) {
  const meta = ctx.tracing.toolMeta.get(callID)
  if (!meta || meta.tool !== "subagent") return
  setBoundedMap(ctx.tracing.toolMeta, callID, { ...meta, executionStarted: true })
  if (ctx.tracing.toolSpans.has(callID) || !isTraceEnabled("tool", ctx)) return
  const { agentName, agentType, agentVersion } = getSessionAgentMeta(meta.sessionID, ctx)
  const span = ctx.tracer.startSpan(
    toolSpanName(ctx.semconv, "subagent", ctx.tracePrefix),
    {
      startTime: meta.startMs,
      kind: SpanKind.INTERNAL,
      attributes: {
        ...toolStartAttrs(ctx.semconv, {
          sessionID: meta.sessionID,
          tool: "subagent",
          callID,
          agent: agentName,
          agentType,
          agentVersion,
          subagent: meta.agent ?? "unknown",
          parentToolCallID: callID,
          ...(meta.turnID ? { turnID: meta.turnID } : {}),
          ...(meta.stepID ? { stepID: meta.stepID } : {}),
        }),
        ...ctx.commonAttrs,
      },
    },
    resolveStepContext(meta.sessionID, meta.assistantMessageID, ctx),
  )
  setBoundedMap(ctx.tracing.toolSpans, callID, span)
  setBoundedMap(ctx.tracing.toolSpanContexts, callID, span.spanContext())
}

function linkSubagent(callID: string, childID: unknown, ctx: HandlerContext) {
  const meta = ctx.tracing.toolMeta.get(callID)
  if (typeof childID !== "string" || meta?.tool !== "subagent" || ctx.tracing.consumedSubagentDispatches.has(callID)) return
  setBoundedMap(ctx.tracing.toolMeta, callID, { ...meta, childSessionID: childID })
  startSubagentSpan(callID, ctx)
  const span = ctx.tracing.toolSpans.get(callID)
  span?.setAttribute("subagent.session_id", childID)
  const spanContext = span?.spanContext()
  if (spanContext) setBoundedMap(ctx.tracing.subagentParents, childID, { spanContext, callID })
}

export function handleToolProgress(e: EventOf<"session.tool.progress">, ctx: HandlerContext) {
  linkSubagent(e.data.id, e.data.metadata["sessionID"], ctx)
}

/** Ends a successful tool call: records duration, sets output attributes, and emits `tool_result`. */
export function handleToolSuccess(e: EventOf<"session.tool.success">, ctx: HandlerContext) {
  linkSubagent(e.data.id, e.data.metadata?.["sessionID"], ctx)
  const output = contentText(e.data.content)
  finishTool(e.data.id, e.data.sessionID, e.created, true, output, undefined, e.data.metadata, ctx)
}

/** Ends a failed tool call: records duration, sets error attributes, and emits `tool_result`. */
export function handleToolFailed(e: EventOf<"session.tool.failed">, ctx: HandlerContext) {
  linkSubagent(e.data.id, e.data.metadata?.["sessionID"], ctx)
  const output = contentText(e.data.content)
  finishTool(e.data.id, e.data.sessionID, e.created, false, output, e.data.error, e.data.metadata, ctx)
}

function finishTool(
  callID: string,
  sessionID: string,
  endMs: number,
  success: boolean,
  output: string,
  error: StructuredError | undefined,
  metadata: Record<string, unknown> | undefined,
  ctx: HandlerContext,
) {
  const meta = ctx.tracing.toolMeta.get(callID)
  ctx.tracing.toolMeta.delete(callID)
  const spanContext = ctx.tracing.toolSpanContexts.get(callID)
  const tool = meta?.tool ?? "unknown"
  const observedExecution = meta?.executionStarted === true
  const start = observedExecution ? meta.startMs : endMs
  const durationMs = Math.max(0, endMs - start)
  const { agentName, agentType, agentVersion } = getSessionAgentMeta(sessionID, ctx)
  const sizeBytes = output ? Buffer.byteLength(output, "utf8") : 0
  const resultHash = output ? sha256Hex(output) : undefined
  const exitCode = exitCodeOf(metadata)

  if (success && observedExecution && meta.command && SHELL_TOOL_RE.test(tool) && GIT_COMMIT_RE.test(meta.command)) {
    if (isMetricEnabled("commit.count", ctx)) {
      ctx.instruments.commitCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID })
    }
    ctx.emitEvent({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      timestamp: endMs,
      observedTimestamp: Date.now(),
      body: "commit",
      attributes: {
        "event.name": "commit",
        ...signalAttrs(ctx.semconv, { sessionID, agent: agentName, agentType, agentVersion }),
        ...ctx.commonAttrs,
      },
    }, spanContext)
  }

  if (observedExecution && ctx.semconv === "gen_ai") {
    if (isMetricEnabled(GEN_AI_METRIC.executeToolDuration, ctx)) {
      ctx.instruments.executeToolDurationHistogram.record(durationMs / 1000, {
        ...ctx.commonAttrs,
        ...toolDurationAttrs({ sessionID, tool, agent: agentName, agentType, agentVersion, success, errorType: error?.type }),
      })
    }
  } else if (observedExecution && isMetricEnabled("tool.duration", ctx)) {
    ctx.instruments.toolDurationHistogram.record(durationMs, {
      ...ctx.commonAttrs,
      ...signalAttrs(ctx.semconv, { sessionID, tool }),
      success,
    })
  }

  const span = ctx.tracing.toolSpans.get(callID)
  if (span) {
    span.setAttributes(toolEndAttrs(ctx.semconv, {
      agent: agentName,
      agentType,
      agentVersion,
      success,
      sizeBytes,
      ...(resultHash ? { resultHash } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(output && ctx.captureContent ? { output } : {}),
      ...(success ? {} : { error }),
    }))
    if (success) {
      span.setStatus({ code: SpanStatusCode.OK })
    } else {
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorSummary(error) })
    }
    span.end(endMs)
  }
  ctx.tracing.toolSpans.delete(callID)
  ctx.tracing.toolSpanContexts.delete(callID)

  ctx.emitEvent({
    severityNumber: success ? SeverityNumber.INFO : SeverityNumber.ERROR,
    severityText: success ? "INFO" : "ERROR",
    timestamp: start,
    observedTimestamp: Date.now(),
    body: "tool_result",
    attributes: {
      "event.name": "tool_result",
      ...signalAttrs(ctx.semconv, { sessionID, agent: agentName, agentType, agentVersion, tool }),
      success,
      duration_ms: durationMs,
      ...toolFactsAttrs(meta?.toolFacts),
      ...toolSemanticsAttrs(meta?.semantics),
      ...(meta?.argsHash ? { [OPENCODE_ATTR.toolArgsHash]: meta.argsHash } : {}),
      ...(resultHash ? { [OPENCODE_ATTR.toolResultHash]: resultHash } : {}),
      ...(exitCode !== undefined ? { [OPENCODE_ATTR.toolExitCode]: exitCode } : {}),
      ...(success ? { tool_result_size_bytes: sizeBytes } : { error: errorSummary(error), ...errorAttrs(error) }),
      ...ctx.commonAttrs,
    },
  }, spanContext)
}

function contentText(content: readonly ToolContent[] | undefined): string {
  if (!content) return ""
  return content
    .map((part) => (part.type === "text" ? part.text : part.name ?? part.uri))
    .filter(Boolean)
    .join("\n")
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}

function argsFingerprint(value: unknown): string | undefined {
  if (!value) return undefined
  try {
    return hashJson(value)
  } catch {
    return undefined
  }
}
