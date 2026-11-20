import { describe, test, expect } from "bun:test"
import {
  exitCodeOf,
  hashJson,
  sha256Hex,
  stableJson,
  toolSemantics,
  toolSemanticsAttrs,
} from "../src/facts.ts"

describe("hashing", () => {
  test("sha256Hex matches the known digest", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })

  test("stableJson sorts object keys recursively", () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
    expect(stableJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]')
  })

  test("hashJson ignores key insertion order", () => {
    expect(hashJson({ b: 1, a: 2 })).toBe(hashJson({ a: 2, b: 1 }))
  })
})

describe("toolSemantics", () => {
  test("file tools report the filesystem data source", () => {
    const semantics = toolSemantics("edit", { path: "src/a.ts" })
    expect(semantics.dataSourceID).toBe("filesystem")
    expect(semantics.dataSourceType).toBe("file")
  })

  test("webfetch reports the destination host without the query", () => {
    const semantics = toolSemantics("webfetch", { url: "https://example.com/a?token=secret" })
    expect(semantics.urlDomain).toBe("example.com")
    expect(semantics.urlFull).toBe("https://example.com/a")
    expect(semantics.urlScheme).toBe("https")
    expect(semantics.dataSourceID).toBe("example.com")
    expect(semantics.dataSourceType).toBe("web")
    expect(toolSemanticsAttrs(semantics)["url.full"]).not.toContain("secret")
  })

  test("shell commands keep the first URL and declared method", () => {
    const semantics = toolSemantics("shell", { command: "curl -X POST https://api.example.com/v1/items?q=1", method: "post" })
    expect(semantics.urlDomain).toBe("api.example.com")
    expect(semantics.httpMethod).toBe("POST")
  })

  test("memory tools expose the operation", () => {
    const semantics = toolSemantics("memory_save", { text: "x" })
    expect(semantics.memoryOperation).toBe("save")
    expect(semantics.dataSourceType).toBe("memory")
  })

  test("mcp tools expose server and tool", () => {
    const semantics = toolSemantics("mcp__github__list_issues", {})
    expect(semantics.mcpServer).toBe("github")
    expect(semantics.mcpTool).toBe("list_issues")
    expect(semantics.mcpMethod).toBe("tools/call")
    expect(semantics.dataSourceID).toBe("mcp:github")
  })

  test("mcp resource helpers expose the protocol method", () => {
    expect(toolSemantics("read_mcp_resource", {}).mcpMethod).toBe("resources/read")
    expect(toolSemantics("list_mcp_resources", {}).mcpMethod).toBe("resources/list")
  })

  test("unknown tools report no data source", () => {
    expect(toolSemantics("question", {})).toEqual({})
  })
})

describe("exitCodeOf", () => {
  test("reads the common metadata keys", () => {
    expect(exitCodeOf({ exitCode: 1 })).toBe(1)
    expect(exitCodeOf({ exit_code: 0 })).toBe(0)
    expect(exitCodeOf({ code: 2 })).toBe(2)
  })

  test("ignores missing or non-numeric values", () => {
    expect(exitCodeOf(undefined)).toBeUndefined()
    expect(exitCodeOf({ exitCode: "1" })).toBeUndefined()
    expect(exitCodeOf({ code: Number.NaN })).toBeUndefined()
  })
})
