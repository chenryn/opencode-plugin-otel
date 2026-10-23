import { beforeAll, describe, expect, test } from "bun:test"
import { runScenario } from "./fixtures.ts"
import { attributes, metricPoints, objects, signalRecords } from "./otlp.ts"

test("exports real OpenCode session telemetry over OTLP/JSON", async () => {
  const { received, requests, result } = await runScenario("text")
  expect(requests).toHaveLength(1)
  expect(result["sessionID"]).toBeString()
  expect(received["traces"]!.length).toBeGreaterThan(0)
  expect(received["metrics"]!.length).toBeGreaterThan(0)
  expect(received["logs"]!.length).toBeGreaterThan(0)

  const spans = signalRecords(received["traces"]!, "Spans")
  const run = spans.find(span => span["name"] === "opencode.session")!
  const llm = spans.find(span => span["name"] === "opencode.llm")!
  expect(attributes(run)["session.id"]).toBe(result["sessionID"])
  expect(llm["traceId"]).toBe(run["traceId"])
  expect(llm["parentSpanId"]).toBe(run["spanId"])
  expect(attributes(llm)["llm.token_count.prompt"]).toBe(20)
  expect(attributes(llm)["llm.token_count.completion"]).toBe(5)

  const metrics = signalRecords(received["metrics"]!, "Metrics")
  const sessions = metricPoints(metrics, "opencode.session.count", "sum").at(-1)!
  expect(Number(sessions["asDouble"] ?? sessions["asInt"])).toBe(1)
  expect(attributes(sessions)["session.id"]).toBe(result["sessionID"])
  const logs = signalRecords(received["logs"]!, "Logs")
  expect(logs.some(log => attributes(log)["event.name"] === "api_request")).toBe(true)
  expect(logs.some(log => attributes(log)["event.name"] === "session.idle")).toBe(true)
}, 40_000)

for (const disabled of [false, true]) {
  describe(`local read with tool tracing ${disabled ? "disabled" : "enabled"}`, () => {
    let scenario: Awaited<ReturnType<typeof runScenario>>
    beforeAll(async () => { scenario = await runScenario("read", { disabledTraces: disabled ? "tool" : "" }) }, 40_000)

    test("executes the real read tool and reports its contents to the provider", () => {
      expect(scenario.requests).toHaveLength(2)
      const messages = objects(scenario.requests[1]!["messages"])
      const result = messages.find(message => message["role"] === "tool")!
      expect(result["tool_call_id"]).toBe("call_read")
      expect(result["content"]).toContain("integration-fixture-contents")
      const tool = objects(scenario.result["messages"])
        .flatMap(message => objects(message["content"])).find(part => part["type"] === "tool")!
      expect(tool["executed"]).toBe(false)
      expect(JSON.stringify(scenario.result).length).toBeGreaterThan(8192)
      expect(result["content"]).toContain("256: integration-fixture-contents")
      const logs = signalRecords(scenario.received["logs"]!, "Logs")
      const log = logs.find(record => attributes(record)["event.name"] === "tool_result")!
      expect(attributes(log)["tool_name"]).toBe("read")
      expect(attributes(log)["success"]).toBe(true)
    })

    if (disabled) {
      test("does not export tool spans", () => {
        expect(signalRecords(scenario.received["traces"]!, "Spans")
          .some(span => String(span["name"]).startsWith("opencode.tool."))).toBe(false)
      })
    } else {
      test("#134: exports a locally executed tool span under its LLM span", () => {
        const spans = signalRecords(scenario.received["traces"]!, "Spans")
        const tool = spans.find(span => span["name"] === "opencode.tool.read")
        expect(tool).toBeDefined()
        const parent = spans.find(span => span["spanId"] === tool!["parentSpanId"])!
        expect(parent["name"]).toBe("opencode.llm")
        expect(tool!["traceId"]).toBe(parent["traceId"])
        expect(attributes(tool!)["output.value"]).toContain("integration-fixture-contents")
      })
    }

    test("#134: exports a duration sample for the locally executed tool", () => {
      const metrics = signalRecords(scenario.received["metrics"]!, "Metrics")
      const points = metricPoints(metrics, "opencode.tool.duration", "histogram")
        .filter(point => attributes(point)["tool_name"] === "read")
      expect(points.length).toBeGreaterThan(0)
      expect(Number(points.at(-1)!["count"])).toBe(1)
      expect(attributes(points.at(-1)!)["success"]).toBe(true)
      const logs = signalRecords(scenario.received["logs"]!, "Logs")
      const log = logs.find(record => attributes(record)["event.name"] === "tool_result")!
      expect(Number(points.at(-1)!["sum"])).toBe(Number(attributes(log)["duration_ms"]))
    })
  })
}

describe("GenAI semantic conventions", () => {
  let quiet: Awaited<ReturnType<typeof runScenario>>
  let verbose: Awaited<ReturnType<typeof runScenario>>
  beforeAll(async () => {
    quiet = await runScenario("text", { semconv: "gen_ai" })
    verbose = await runScenario("text", { semconv: "gen_ai", captureModelContext: true })
  }, 90_000)

  test("replaces every OpenInference attribute with its GenAI equivalent", () => {
    const spans = signalRecords(quiet.received["traces"]!, "Spans")
    expect(spans.every(span => attributes(span)["openinference.span.kind"] === undefined)).toBe(true)
    expect(spans.every(span => Object.keys(attributes(span)).every(key => !key.startsWith("llm.")))).toBe(true)
    expect(spans.every(span => attributes(span)["gen_ai.operation.name"] !== undefined)).toBe(true)
  })

  test("names spans after the GenAI operation and model", () => {
    const spans = signalRecords(quiet.received["traces"]!, "Spans")
    const run = spans.find(span => attributes(span)["gen_ai.operation.name"] === "invoke_agent")!
    expect(String(run["name"])).toBe(`invoke_agent ${attributes(run)["gen_ai.agent.name"]}`)
    expect(attributes(run)["gen_ai.conversation.id"]).toBe(quiet.result["sessionID"])

    const llm = spans.find(span => attributes(span)["gen_ai.operation.name"] === "chat")!
    expect(String(llm["name"])).toBe("chat scripted")
    expect(llm["parentSpanId"]).toBe(run["spanId"])
    expect(attributes(llm)["gen_ai.request.model"]).toBe("scripted")
    expect(attributes(llm)["gen_ai.usage.input_tokens"]).toBe(20)
    expect(attributes(llm)["gen_ai.usage.output_tokens"]).toBe(5)
    expect(attributes(llm)["gen_ai.response.finish_reasons"]).toEqual(["stop"])
  })

  test("omits the opt-in content attributes by default", () => {
    const spans = signalRecords(quiet.received["traces"]!, "Spans")
    for (const span of spans) {
      expect(attributes(span)["gen_ai.input.messages"]).toBeUndefined()
      expect(attributes(span)["gen_ai.output.messages"]).toBeUndefined()
      expect(attributes(span)["input.value"]).toBeUndefined()
      expect(attributes(span)["output.value"]).toBeUndefined()
    }
  })

  test("emits the opt-in content attributes under OPENCODE_CAPTURE_MODEL_CONTEXT", () => {
    const spans = signalRecords(verbose.received["traces"]!, "Spans")
    const llm = spans.find(span => attributes(span)["gen_ai.operation.name"] === "chat")!
    const output = JSON.parse(String(attributes(llm)["gen_ai.output.messages"]))
    expect(output[0]["role"]).toBe("assistant")
    expect(output[0]["parts"][0]).toEqual({ type: "text", content: "Fixture complete." })
    const input = JSON.parse(String(attributes(llm)["gen_ai.input.messages"]))
    expect(input.map((message: { role: string }) => message["role"])).toContain("user")
  })

  test("records the official GenAI histograms instead of the OpenInference counters", () => {
    const metrics = signalRecords(quiet.received["metrics"]!, "Metrics")
    expect(metricPoints(metrics, "opencode.token.usage", "sum")).toHaveLength(0)

    const usage = metricPoints(metrics, "gen_ai.client.token.usage", "histogram")
    const typed = (type: string) => usage.filter(point => attributes(point)["gen_ai.token.type"] === type).at(-1)!
    expect(Number(typed("input")["sum"])).toBe(20)
    expect(Number(typed("output")["sum"])).toBe(5)
    expect(attributes(typed("input"))["gen_ai.request.model"]).toBe("scripted")
    expect(attributes(typed("input"))["gen_ai.conversation.id"]).toBe(quiet.result["sessionID"])

    const duration = metricPoints(metrics, "gen_ai.client.operation.duration", "histogram").at(-1)!
    expect(Number(duration["count"])).toBe(1)
    expect(attributes(duration)["gen_ai.operation.name"]).toBe("chat")
    expect(attributes(duration)["error.type"]).toBeUndefined()
  })

  test("drops the log events that duplicate a span", () => {
    const names = signalRecords(quiet.received["logs"]!, "Logs").map(log => String(attributes(log)["event.name"]))
    for (const redundant of ["api_request", "api_error", "tool_result", "session.created"]) {
      expect(names).not.toContain(redundant)
    }
    expect(names).toContain("user_prompt")
    expect(names).toContain("session.idle")
    const prompt = signalRecords(quiet.received["logs"]!, "Logs")
      .find(log => attributes(log)["event.name"] === "user_prompt")!
    expect(attributes(prompt)["gen_ai.conversation.id"]).toBe(quiet.result["sessionID"])
    expect(attributes(prompt)["agent"]).toBeUndefined()
    expect(attributes(prompt)["prompt"]).toBeUndefined()
  })

  test("keeps the prompt text on the surviving log event when content capture is on", () => {
    const prompt = signalRecords(verbose.received["logs"]!, "Logs")
      .find(log => attributes(log)["event.name"] === "user_prompt")!
    expect(String(attributes(prompt)["prompt"])).toBeString()
  })
})
