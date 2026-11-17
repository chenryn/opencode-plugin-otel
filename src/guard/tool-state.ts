// otel.guard — per-call staged tool arguments.
//
// `tool.execute.before` fires before the tool's own `permission.assert`, which is
// where `permission.evaluate` runs. This module holds the structured, typed tool
// input from the before hook so the permission decision can match the real
// command/URL instead of the lossy `resources[0]` string. Entries are bounded and
// expire so a missed after hook can never leak state across sessions.

import type { ArgsDigest } from "./audit.ts"

/** Maximum number of staged tool calls kept in memory. */
export const MAX_STAGED_TOOL_CALLS = 512
/** Staged entries older than this are ignored (a call that never reached evaluate). */
export const STAGED_TOOL_TTL_MS = 5 * 60 * 1000

/** Structured input staged for one tool call. */
export type StagedToolCall = {
  callID: string
  tool: string
  sessionID: string
  agent: string | undefined
  messageID: string | undefined
  input: unknown
  digest: ArgsDigest
  stagedAt: number
  /** Set by the before hook when the positive allowlist rejected the arguments. */
  allowlistDenial?: string
}

/** Bounded FIFO store of staged tool calls, keyed by call id. */
export type ToolState = {
  calls: Map<string, StagedToolCall>
}

/** Create an empty tool-call state. */
export function createToolState(): ToolState {
  return { calls: new Map() }
}

/**
 * Stage a tool call's structured input. Oldest entries are evicted once the
 * bound is reached so a long-running session cannot grow the map without limit.
 */
export function stageToolCall(state: ToolState, call: StagedToolCall): void {
  state.calls.delete(call.callID)
  state.calls.set(call.callID, call)
  while (state.calls.size > MAX_STAGED_TOOL_CALLS) {
    const oldest = state.calls.keys().next()
    if (oldest.done) break
    state.calls.delete(oldest.value)
  }
}

/**
 * Look up a staged call by id without removing it. Returns `undefined` when the
 * entry is absent or expired (expired entries are pruned on access).
 */
export function peekToolCall(state: ToolState, callID: string, now = Date.now()): StagedToolCall | undefined {
  const call = state.calls.get(callID)
  if (!call) return undefined
  if (now - call.stagedAt > STAGED_TOOL_TTL_MS) {
    state.calls.delete(callID)
    return undefined
  }
  return call
}

/** Remove a staged call after it has been consumed (e.g. by `execute.after`). */
export function consumeToolCall(state: ToolState, callID: string): StagedToolCall | undefined {
  const call = state.calls.get(callID)
  state.calls.delete(callID)
  return call
}

/**
 * Pull a matchable text payload out of structured tool input: the command for
 * shell tools, the URL for fetch/web tools, and the path for file tools. Returns
 * `null` when no recognised field is present or the field is not a string.
 */
export function toolInputText(tool: string, input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null
  const args = input as Record<string, unknown>
  const name = tool.toLowerCase()
  const fields = SHELL_TOOLS.has(name)
    ? ["command"]
    : FETCH_TOOLS.has(name)
      ? ["url"]
      : FILE_TOOLS.has(name)
        ? ["filePath", "path"]
        : []
  for (const field of fields) {
    const value = args[field]
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}

/** Whether a tool name carries a shell command in its structured input. */
export function isShellTool(tool: string): boolean {
  return SHELL_TOOLS.has(tool.toLowerCase())
}

/** Tool names whose `command` argument carries a shell command. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "shell", "execute", "opencode"])
/** Tool names whose `url` argument carries an outbound request target. */
const FETCH_TOOLS: ReadonlySet<string> = new Set(["webfetch", "fetch", "http", "curl"])
/** Tool names whose path argument carries a filesystem target. */
const FILE_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "patch", "glob", "grep", "list"])
