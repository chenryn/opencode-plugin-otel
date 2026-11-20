import { createHash } from "node:crypto"
import type { Attributes } from "@opentelemetry/api"

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

/**
 * Serializes a value with object keys sorted recursively so the same logical payload
 * always hashes to the same digest. Returns the input unchanged for non-objects.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? ""
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`
}

/** SHA-256 digest of a canonical JSON payload; used for arguments, prompts, and fingerprints. */
export function hashJson(value: unknown): string {
  return sha256Hex(stableJson(value))
}

/** Attachment and destination facts derived from a tool call. Never carries content or judgement. */
export type ToolSemantics = {
  /** Logical data source id, for example `filesystem`, `web`, `memory`, or `mcp:<server>`. */
  dataSourceID?: string
  /** Data source kind, for example `file`, `web`, `memory`, `mcp`, or `shell`. */
  dataSourceType?: string
  /** Destination host for an outbound tool call. */
  urlDomain?: string
  /** Destination URL with query and fragment removed so credentials never leak. */
  urlFull?: string
  /** Destination URL scheme, for example `https`. */
  urlScheme?: string
  /** HTTP method when the tool input declares one. */
  httpMethod?: string
  /** MCP server name for an MCP-backed tool. */
  mcpServer?: string
  /** MCP tool name for an MCP-backed tool. */
  mcpTool?: string
  /** MCP protocol method, for example `tools/call` or `resources/read`. */
  mcpMethod?: string
  /** Memory operation derived from a memory tool name, for example `save` or `search`. */
  memoryOperation?: string
}

const MEMORY_TOOL_RE = /^memory[_:.-]([a-z0-9_]+)$/i
const MCP_TOOL_RE = /^mcp(?:__|[:._])([^:._]+)(?:__|[:._])([a-z0-9_.-]+)$/i
const MCP_RESOURCE_TOOLS: Readonly<Record<string, string>> = {
  list_mcp_resources: "resources/list",
  read_mcp_resource: "resources/read",
}
const URL_KEYS = ["url", "uri", "href", "endpoint"] as const
const URL_RE = /https?:\/\/[^\s"'<>]+/i
const FILE_TOOL_NAMES = new Set(["read", "view", "write", "create", "edit", "multiedit", "patch", "apply_patch", "list", "ls", "glob", "grep", "search"])
const WEB_TOOL_NAMES = new Set(["webfetch", "websearch", "fetch", "web_search"])
const SHELL_TOOL_NAMES = new Set(["bash", "shell", "execute"])

/** Parses a URL into destination facts, dropping the query and fragment. */
function urlFacts(raw: string): Pick<ToolSemantics, "urlDomain" | "urlFull" | "urlScheme"> | undefined {
  try {
    const url = new URL(raw)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    return {
      urlDomain: url.hostname.toLowerCase(),
      urlFull: `${url.protocol}//${url.host}${url.pathname}`,
      urlScheme: url.protocol.slice(0, -1),
    }
  } catch {
    return undefined
  }
}

/** Finds the first declared destination in the tool input or its shell command. */
function destinationOf(tool: string, input: Record<string, unknown>): Pick<ToolSemantics, "urlDomain" | "urlFull" | "urlScheme" | "httpMethod"> | undefined {
  for (const key of URL_KEYS) {
    const value = input[key]
    if (typeof value === "string" && value) {
      const facts = urlFacts(value)
      if (facts) return { ...facts, ...httpMethodOf(input) }
    }
  }
  if (SHELL_TOOL_NAMES.has(tool)) {
    const command = input["command"]
    if (typeof command === "string") {
      const match = command.match(URL_RE)
      if (match) {
        const facts = urlFacts(match[0])
        if (facts) return { ...facts, ...httpMethodOf(input) }
      }
    }
  }
  void tool
  return undefined
}

/** Returns the HTTP method only when the tool input declares one. */
function httpMethodOf(input: Record<string, unknown>): { httpMethod?: string } {
  const method = input["method"]
  return typeof method === "string" && /^[A-Za-z]+$/.test(method)
    ? { httpMethod: method.toUpperCase() }
    : {}
}

/** Derives attachment and destination facts from a tool name and its arguments. */
export function toolSemantics(tool: string, input: Record<string, unknown>): ToolSemantics {
  const name = tool.toLowerCase().split(".").at(-1) ?? tool.toLowerCase()
  const semantics: ToolSemantics = {}
  const memory = tool.match(MEMORY_TOOL_RE)
  if (memory) {
    semantics.memoryOperation = memory[1]!.toLowerCase()
    semantics.dataSourceID = "memory"
    semantics.dataSourceType = "memory"
  }

  const mcp = tool.match(MCP_TOOL_RE)
  if (mcp) {
    semantics.mcpServer = mcp[1]
    semantics.mcpTool = mcp[2]
    semantics.mcpMethod = "tools/call"
    semantics.dataSourceID = `mcp:${mcp[1]}`
    semantics.dataSourceType = "mcp"
  } else if (MCP_RESOURCE_TOOLS[name]) {
    semantics.mcpServer = "opencode"
    semantics.mcpMethod = MCP_RESOURCE_TOOLS[name]
    semantics.dataSourceID = "mcp:opencode"
    semantics.dataSourceType = "mcp"
  }

  const destination = destinationOf(name, input)
  if (destination) {
    semantics.urlDomain = destination.urlDomain
    semantics.urlFull = destination.urlFull
    semantics.urlScheme = destination.urlScheme
    if (destination.httpMethod) semantics.httpMethod = destination.httpMethod
    if (!semantics.dataSourceID) {
      semantics.dataSourceID = destination.urlDomain ?? "web"
      semantics.dataSourceType = "web"
    }
  }

  if (!semantics.dataSourceID) {
    if (FILE_TOOL_NAMES.has(name)) {
      semantics.dataSourceID = "filesystem"
      semantics.dataSourceType = "file"
    } else if (WEB_TOOL_NAMES.has(name)) {
      semantics.dataSourceID = "web"
      semantics.dataSourceType = "web"
    } else if (SHELL_TOOL_NAMES.has(name)) {
      semantics.dataSourceID = "shell"
      semantics.dataSourceType = "shell"
    }
  }
  return semantics
}

/** Returns a numeric process exit code from tool result metadata when one is present. */
export function exitCodeOf(metadata: Record<string, unknown> | undefined): number | undefined {
  if (!metadata) return undefined
  for (const key of ["exitCode", "exit_code", "code"]) {
    const value = metadata[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

/** Attributes for the destination and data-source facts of a tool call. */
export function toolSemanticsAttrs(semantics: ToolSemantics | undefined): Attributes {
  if (!semantics) return {}
  const attrs: Attributes = {}
  if (semantics.dataSourceID) attrs["gen_ai.data_source.id"] = semantics.dataSourceID
  if (semantics.dataSourceType) attrs["gen_ai.data_source.type"] = semantics.dataSourceType
  if (semantics.urlDomain) attrs["url.domain"] = semantics.urlDomain
  if (semantics.urlFull) attrs["url.full"] = semantics.urlFull
  if (semantics.urlScheme) attrs["url.scheme"] = semantics.urlScheme
  if (semantics.httpMethod) attrs["http.request.method"] = semantics.httpMethod
  if (semantics.mcpServer) attrs["mcp.server.name"] = semantics.mcpServer
  if (semantics.mcpTool) attrs["mcp.tool.name"] = semantics.mcpTool
  if (semantics.mcpMethod) attrs["mcp.method.name"] = semantics.mcpMethod
  if (semantics.memoryOperation) attrs["gen_ai.memory.operation"] = semantics.memoryOperation
  return attrs
}
