// Unit tests for the RFC 8785 canonical JSON serializer.
// Run: bun test tests/guard-canonical-json.test.ts

import { describe, expect, test } from "bun:test"
import { canonicalJson } from "../src/guard/canonical-json.ts"

describe("canonicalJson", () => {
  test("sorts keys by UTF-16 code unit, independent of insertion order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}')
  })

  test("does not reorder integer-like keys via JS object semantics", () => {
    const doc = { "10": "x", "2": "y" }
    expect(canonicalJson(doc)).toBe('{"10":"x","2":"y"}')
  })

  test("handles arrays, null, booleans and strings", () => {
    expect(canonicalJson([3, null, true, "x"])).toBe('[3,null,true,"x"]')
  })

  test("honours toJSON", () => {
    expect(canonicalJson({ t: new Date("2020-01-01T00:00:00.000Z") })).toBe('{"t":"2020-01-01T00:00:00.000Z"}')
  })

  test("strict mode rejects undefined, bigint, cycles and non-finite numbers", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow()
    expect(() => canonicalJson(1n)).toThrow()
    expect(() => canonicalJson(Number.NaN)).toThrow()
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => canonicalJson(cycle)).toThrow(/circular/)
  })

  test("lenient mode drops undefined, maps non-finite to null, allows cycles to throw", () => {
    expect(canonicalJson({ a: undefined, b: 1 }, { lenient: true })).toBe('{"b":1}')
    expect(canonicalJson(Number.POSITIVE_INFINITY, { lenient: true })).toBe("null")
    expect(canonicalJson([undefined, 1], { lenient: true })).toBe("[null,1]")
  })

  test("enforces maxDepth", () => {
    expect(() => canonicalJson({ a: { b: { c: 1 } } }, { maxDepth: 2 })).toThrow(/depth/)
  })
})
