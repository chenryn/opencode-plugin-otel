# Telemetry

Everything this plugin exports, how the signals are shaped, and how to point them at a backend. Telemetry is inactive until `OPENCODE_ENABLE_TELEMETRY` (or the `enabled` option) is set.

- [How it works](#how-it-works)
- [What it emits](#what-it-emits)
- [Content and privacy](#content-and-privacy)
- [Semantic conventions](#semantic-conventions)
- [Model-visible context](#model-visible-context)
- [LLM trace propagation](#llm-trace-propagation)
- [Disabling signals](#disabling-signals)
- [Multi-instance consistency](#multi-instance-consistency)
- [Backend examples](#backend-examples)

Configuration reference: [configuration.md](./configuration.md). Guard: [guard.md](./guard.md).

## How it works

### Signal pipeline

OpenCode's V2 event stream and hooks feed handlers that maintain per-session trace state and emit three signal types through a shared OTel SDK:

```text
event stream / hooks  ──▶  handlers/*  ──▶  span + metric + log event
                                             │
                                             └─▶  OTLP exporter (grpc | http/protobuf | http/json)
```

The SDK is acquired once per process and reference-counted. Providers are never shut down, so a plugin reload can reuse them. Exporters are rebuilt on authentication failure when a dynamic-header helper is configured, and the failed batch is retried once. A TCP probe (5 s timeout) runs against the endpoint on startup; a failure is logged, not fatal.

Event processing is serialized so an asynchronous session lookup cannot reorder step start/end events. Event attributes prefer the observed session's project ID.

**Trace identity survives a reload.** The run and step span contexts are written through to the plugin storage API under `chenryn.otel/tracing/1/<sessionID>`. When OpenCode replaces the plugin instance mid-turn (config change, project switch), the new instance adopts those contexts so the remaining spans join the trace that was already exported, and the last instance ends any open span on unload instead of dropping it. `session.deleted` removes the record together with every per-session correlation map.

### Trace model

Each user turn produces a run span; each LLM request a child span; each tool call a child of its step:

```text
run span  ({prefix}session / invoke_agent)
├── LLM step span  ({prefix}llm / chat)        [SpanKind.CLIENT]
├── compaction span  ({prefix}compaction)
└── tool span  ({prefix}tool.{name} / execute_tool)
    └── subagent run span  (nested when correlatable)
```

Spans are never `activate`d; parentage is passed explicitly via context objects, and log events are stamped with the target span's trace/span id. This keeps correlation deterministic under concurrent sessions.

When an unambiguous child session ID is available from subagent tool progress or result metadata, the child run span nests under its dispatch tool span. Ambiguous correlations fall back to the parent run span. Both sides carry `parent_tool_call_id` as a join key; the run span also carries `parent_session_id`.

**Reasons this plugin consumes the V2 stream directly:** V2 replaced the coarse V1 message events (`message.updated`, `message.part.updated`) and removed `command.executed` and `session.diff` from the plugin event stream. It adds `permission.asked` / `permission.replied` in place of V1's `permission.updated`, plus a granular session taxonomy (`session.execution.*`, `session.step.*`, `session.tool.*`, `session.usage.updated`, `session.retry.scheduled`), which yields more accurate LLM and tool span timings.

V1 signal parity: `lines_of_code.count` / `lines_of_code.total` depended on `session.diff` and are not emitted — the V2 plugin context does not expose a per-session diff endpoint. `command.executed` instrumentation is replaced by successful shell-tool completion. Message/part spans are replaced by per-step LLM spans.

## What it emits

### Metrics

Metrics are prefixed with `OPENCODE_METRIC_PREFIX` (default `opencode.`) unless they are GenAI-standard names, which are never prefixed.

| Metric | Type | Description |
|--------|------|-------------|
| `opencode.session.count` | Counter | Sessions started, or lazily on first observation of a pre-existing session |
| `opencode.token.usage` | Counter | Tokens by type: `input`, `output`, `reasoning`, `cacheRead`, `cacheCreation` |
| `opencode.cost.usage` | Counter | USD cost per completed LLM step |
| `opencode.commit.count` | Counter | `git commit` seen in a successful shell tool call (the resulting repo state is not verified) |
| `opencode.tool.duration` | Histogram | Tool execution time in ms |
| `opencode.cache.count` | Counter | Cache read/write activity per step (`type=cacheRead` / `cacheCreation`) |
| `opencode.session.duration` | Histogram | Session creation (or first observation) to execution end / idle, in ms |
| `opencode.message.count` | Counter | Assistant messages with a completed or failed step |
| `opencode.session.token.total` | Histogram | Total tokens per session, recorded when an execution ends |
| `opencode.session.cost.total` | Histogram | Total USD cost per session, recorded when an execution ends |
| `opencode.model.usage` | Counter | Messages per model and provider |
| `opencode.retry.count` | Counter | API retries from `session.retry.scheduled` events (`retry.attempt`, `error.type`); never added to normal calls |
| `opencode.subtask.count` | Counter | Sub-agent sessions observed via `session.created` with a `parentID` |
| `opencode.exporter.export.failures` | Counter | Failed OTLP export batches, by `signal` and `error.type`; counted per batch and only on failure |
| `opencode.exporter.auth.retry.count` | Counter | Header refreshes after an auth failure, by `signal` |
| `opencode.event.dispatch.errors` | Counter | Event-dispatch failures, by `event.type` |
| `opencode.flush.failures` | Counter | Scheduled flushes with at least one failing provider |
| `opencode.flush.duration` | Histogram | Scheduled flush duration in ms |
| `opencode.guard.decisions` | Counter | Guard `permission.evaluate` decisions (opt-in) |
| `opencode.guard.tool.actions` | Counter | Guard tool actions: `staged` / `allowlist_denied` / `redacted` / `tool_error` (opt-in) |

Under `OPENCODE_SEMCONV=gen_ai`, the inference and tool metrics are replaced by their official counterparts, which are never prefixed and ignore `OPENCODE_METRIC_PREFIX`. `opencode.token.usage` and `opencode.tool.duration` are not emitted at all in that mode:

| Metric | Type | Description |
|--------|------|-------------|
| `gen_ai.client.inference.duration` | Histogram | LLM request duration in seconds, with `error.type` on failure |
| `gen_ai.client.inference.usage.input_tokens` | Counter | Input tokens including cache reads/writes (`gen_ai.token.modality=unknown`) |
| `gen_ai.client.inference.usage.output_tokens` | Counter | Output tokens including reasoning (`gen_ai.token.modality=text`) |
| `gen_ai.client.inference.usage.cache_read.input_tokens` | Counter | Cache-read input tokens, a subset of the input counter |
| `gen_ai.client.inference.usage.cache_write.input_tokens` | Counter | Cache-write input tokens, a subset of the input counter |
| `gen_ai.client.inference.usage.reasoning.output_tokens` | Counter | Reasoning output tokens, a subset of the output counter |
| `gen_ai.execute_tool.duration` | Histogram | Tool execution time in seconds, with `error.type` on failure |
| `gen_ai.server.time_to_first_token` | Histogram | Time to first streamed token in seconds (emitted in both dialects) |

> These names track the current `semantic-conventions-genai` revision, not the 1.40 release, which used `gen_ai.client.token.usage` and `gen_ai.client.operation.duration`. A dashboard written for 1.40 needs a rename or a collector transform.

### Traces

Span naming by dialect:

| Concept | `openinference` (default) | `gen_ai` |
|---------|---------------------------|----------|
| Run span | `{prefix}session` | `invoke_agent {agent}` |
| LLM span | `{prefix}llm` | `chat {model}` |
| Tool span | `{prefix}tool.{tool}` | `execute_tool {tool}` |
| Compaction span | `{prefix}compaction` | `{prefix}compaction` |
| Span type key | `openinference.span.kind` = `AGENT`/`LLM`/`TOOL` | `gen_ai.operation.name` = `invoke_agent`/`chat`/`execute_tool` |

The run span carries the execution's accumulated assistant text as `output.value` (`gen_ai.output.messages` under the GenAI dialect), so a trace is readable without opening every step. Context compaction is traced as its own span (`compaction.reason`, `duration_ms`, tokens, cost, and the gated summary). Streamed reasoning text is kept beside the step answer as `content.reasoning` (also a `reasoning` part of `gen_ai.output.messages`).

### Log events

| Event | Description |
|-------|-------------|
| `session.created` | Session started |
| `session.idle` | Session went idle (totals for tokens, cost, messages) |
| `session.error` | Execution failed |
| `user_prompt` | User prompt durably admitted via `session.inbox.enqueued` (`prompt_length`, `delivery`; also `prompt` when `OPENCODE_CAPTURE_PROMPT_IN_LOGS` is set) |
| `api_request` | Completed LLM step (tokens, cost) |
| `api_error` | Failed LLM step (structured error) |
| `session.retry` | API retry scheduled, one record per attempt (`retry.attempt`, `session.retry.count`, structured error), tied to the run span |
| `compaction` | Context compaction finished or failed (`duration_ms`, tokens, cost, `compaction.reason`, `success`) |
| `tool_result` | Tool completed or errored (duration, success, output size) |
| `permission.requested` | Permission prompt asked (`permission.action`, `permission.resources`, `request.id`, `target.tool_call.id`, `target.span.id`) |
| `tool_decision` | Permission answered (accept/reject), with the same correlation keys plus `permission.wait_ms` (time the approver took); never records a policy verdict |
| `commit` | Git commit detected |
| `subtask_invoked` | Sub-agent session created (agent and parent session id) |
| `policy.decision` | Guard verdict per `permission.evaluate` (opt-in) |
| `guard.tool.before` / `guard.tool.after` | Tool staging, allowlist verdict, output redaction, failed-call audit (opt-in) |
| `guard.prompt.injection` | User-prompt injection finding: ids, severity, hash, blocked flag — never prompt text (opt-in) |
| `prompt_defense` | System-prompt defense coverage: grade, score, finding ids — never prompt text (opt-in) |

In the `gen_ai` dialect, `session.created`, `api_request`, `api_error`, `tool_result`, and `compaction` duplicate a span that already carries the same information. They are emitted by default so an audit timeline keeps every lifecycle marker; set `OPENCODE_EMIT_REDUNDANT_EVENTS=0` to suppress them when spans and events feed the same backend. Other events keep their `event.name` schema but use GenAI identity keys (`gen_ai.conversation.id`, `gen_ai.agent.name`, `gen_ai.request.model`, `gen_ai.provider.name`, `gen_ai.tool.name`); `session.id` remains the cross-signal join key in both dialects.

### Errors

Every failure event (`api_error`, `session.error`, `tool_result` with `success=false`, rejected `tool_decision`) carries a structured error: `error.type` is the grouping key, with `error.message` and `error.status` preserved. A rejected permission records `permission.decision=reject` with `error.type=permission_denied` — it reports the fact only and never enforces policy.

### Facts

Tool spans and `tool_result` events carry a **fact layer**, emitted even when content capture is off: `tool.command` (verbatim shell command) and `file.operation` / `file.path` / `file.paths` (`read`, `write`, `edit`, `list`, `glob`, `search`). Set `OPENCODE_CAPTURE_TOOL_FACTS=0` to suppress it when raw commands must not leave the host. The passive telemetry path writes no judgement fields; detection and enforcement belong to the opt-in [guard](./guard.md).

### Fingerprints

`opencode.tool.args.hash` hashes the tool arguments with recursively sorted object keys (array order is preserved), so logically identical calls hash identically no matter how the model ordered its JSON. `opencode.tool.result.hash` hashes the joined result text. Both are emitted whether or not content capture is on, which is what lets a backend detect argument-stable and result-stable loops without reading payloads. `opencode.prompt.hash`, `opencode.toolset.hash`, and `opencode.agent.config_hash` follow the same canonical serialization.

## Content and privacy

**Content capture is opt-in and bounded.** Content-bearing attributes are capped at 20,000 characters. A truncated value carries `<field>.truncated=true` and `<field>.original_length` (`tool.arguments`, `tool.result`, `content.output`, `content.input`, `content.reasoning`, `content.snapshot`, `prompt`, `tool.command`); counters such as `prompt_length` and `tool.result_size_bytes` always report the original size. A cut multi-path list also reports `file.paths.truncated` and `file.paths.original_count`.

**Cost is only reported when it is known.** opencode reports `cost: 0` for providers and proxies without per-model pricing, so a zero is written as "no cost attribute" rather than "$0". This lets a backend with its own model pricing (for example Langfuse) fill the value in instead of displaying a real request as free. `session.total_cost_usd` remains a literal total.

**Full-context snapshot is a separate opt-in.** `OPENCODE_CAPTURE_CONTEXT_SNAPSHOT=1` (or `captureContextSnapshot: true`) attaches the complete model-visible request — system prompt, every message, and the tool definitions — to the LLM span, which is what makes a trace self-contained for replay and prompt debugging. It is off by default because it exports the whole conversation, including any secrets present in tool output. In `openinference` it lands in `input.value` as JSON (`input.mime_type=application/json`); in `gen_ai` it lands in the `content.snapshot` extension so `gen_ai.input.messages` stays spec-shaped. The snapshot is capped at 100,000 characters.

## Semantic conventions

`OPENCODE_SEMCONV` (or `semconv`) selects the wire dialect for spans, metrics, and log events together. `openinference` is the default and what existing dashboards query; `gen_ai` targets GenAI-native backends. Aliases: `open-inference` → `openinference`, `gen-ai`/`genai` → `gen_ai`. An unrecognized value warns and falls back to `openinference`.

| Aspect | `openinference` (default) | `gen_ai` |
|--------|---------------------------|----------|
| Identity | `session.id`, `agent.name`, `llm.model_name` / `llm.provider` | `gen_ai.conversation.id` (+ `session.id`), `gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.agent.version`, `gen_ai.request.model` / `gen_ai.response.model`, `gen_ai.provider.name` |
| Input | `input.value`, `llm.input_messages` as `[{role, content}]` | `gen_ai.input.messages` as `[{role, parts:[{type:"text", content}]}]` |
| Output | `output.value`, `llm.output_messages` | `gen_ai.output.messages` |
| Tokens | `llm.token_count.prompt` / `.completion` / `.total`, plus cache details | `gen_ai.usage.input_tokens` (prompt + cache), `.output_tokens` (completion + reasoning), separate cache/read counters, `gen_ai.token.modality` |
| Finish reason | `llm.finish_reason` (string) | `gen_ai.response.finish_reasons` (array) |
| Cost | `llm.cost.total`, `cost_usd` | `gen_ai.usage.cost`, `session.total_cost_usd` |
| Tool call | `tool.id`, `tool.name`, `tool.parameters` | `gen_ai.tool.call.id`, `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` |
| Correlation | — | `gen_ai.turn.id` and `gen_ai.step.id` (plugin extensions) |
| Errors | span status + `llm.finish_reason` + `error.type` / `.message` / `.status` | span status + `error.type` / `.message` / `.status` |

`gen_ai.agent.id` is a stable OpenCode role id (`opencode:<agent>`), not a per-session id: OpenCode has no provider-assigned agent registry id, and the spec forbids synthesizing one from a transient in-memory identifier. Unresolved `unknown` agents do not get an id. `gen_ai.agent.version` comes from `OPENCODE_AGENT_VERSION` and falls back to the OpenCode app version. Because one process can host several agents (`build`, `opencode-memory-extract`, subagents), the plugin uses span-level `gen_ai.agent.*` rather than a single `gen_ai.main_agent` resource entity.

`gen_ai.token.modality` is `text` for output tokens and `unknown` for prompt/cache tokens, because OpenCode receives one aggregate prompt count. Turn ids are `<sessionID>:<sequence>`, strictly increasing per session; a tool span carries the same turn id plus the owning assistant message id as `gen_ai.step.id`. OpenCode-specific attributes (`agent.type`, `session.is_subagent`, `parent_session_id`, `parent_tool_call_id`, retry fields, session totals, `tool.success`, `tool.error`, `tool.result_size_bytes`, error fields, subagent agent, and anything from `OPENCODE_SPAN_ATTRIBUTES`) are emitted in both dialects.

## Model-visible context

```bash
export OPENCODE_CAPTURE_MODEL_CONTEXT=1
```

Captures up to two system parts and the last twelve messages, text only, each truncated to 1,000 characters, into the matching primary LLM span (`llm.input_messages`, with the latest user text also in `input.value`). Under `OPENCODE_SEMCONV=gen_ai`, the same flag also gates every content-bearing GenAI attribute that the conventions mark Opt-In (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, and the `prompt` log attribute). Media bytes and structured tool payloads are never copied. The hook observes context at its position in plugin order; later plugins can still change the request. Use only with a trusted collector.

For the complete request (system prompt, all messages, tool schemas), see `OPENCODE_CAPTURE_CONTEXT_SNAPSHOT` under [Content and privacy](#content-and-privacy).

## LLM trace propagation

```bash
export OPENCODE_TRACE_PROPAGATION_PROVIDERS="company-litellm,vllm"
```

For matching provider IDs, the plugin injects the active LLM span as W3C `traceparent` (and `tracestate` when present) so traces join spans emitted by an LLM gateway. Propagation is limited to primary agent-loop requests whose provider, model, and agent match the active step; title, compaction, and transient generations are not parented. Values are OpenCode provider IDs; `*` enables all providers. Only W3C trace context is injected — no arbitrary headers or baggage. For WebSocket-backed providers, the plugin also injects on the experimental `experimental.ws.handshake` hook; enabling it can reopen reused sockets, so verify against your provider.

## Disabling signals

`OPENCODE_DISABLE_METRICS` takes comma-separated metric suffixes without the prefix; disabling a metric stops increments but leaves its log events intact. Under `gen_ai`, list GenAI metrics by full name.

```bash
export OPENCODE_DISABLE_METRICS="cache.count,session.duration,retry.count"
export OPENCODE_DISABLE_LOGS=1
export OPENCODE_DISABLE_TRACES="llm,tool"
```

The following are OpenCode-only and have no Claude Code equivalent, so disable them when using a Claude Code dashboard: `cache.count`, `session.duration`, `session.token.total`, `session.cost.total`, `model.usage`, `retry.count`, `message.count`, `exporter.*`, `event.dispatch.errors`, `flush.*`. For full dashboard compatibility also set `OPENCODE_METRIC_PREFIX=claude_code.`.

## Multi-instance consistency

When several plugin instances load in one process (global plus project config), all **telemetry** options must be identical. A different endpoint, authentication, resource attribute, prefix, or signal option fails setup rather than exporting one location's data with another's settings. The fingerprint covers all telemetry fields with the three set-valued fields sorted; `logLevel` and the entire `guard` config are excluded, so projects may enable different guard features while sharing one OTel SDK. Process-wide shared event processing is serialized for deterministic ordering.

## Backend examples

```bash
# SigNoz
export OPENCODE_OTLP_ENDPOINT="https://ingest.us.signoz.cloud:443"
export OPENCODE_OTLP_HEADERS="signoz-ingestion-key=<KEY>"

# Datadog (delta temporality is required)
export OPENCODE_OTLP_ENDPOINT=https://otlp.datadoghq.com
export OPENCODE_OTLP_PROTOCOL=http/protobuf
export OPENCODE_OTLP_HEADERS="dd-api-key=<KEY>"
export OPENCODE_OTLP_METRICS_TEMPORALITY=delta

# Honeycomb
export OPENCODE_OTLP_ENDPOINT=https://api.honeycomb.io
export OPENCODE_OTLP_PROTOCOL=http/protobuf

# Grafana Cloud
export OPENCODE_OTLP_ENDPOINT=https://otlp-gateway-prod-us-central-0.grafana.net/otlp
export OPENCODE_OTLP_PROTOCOL=http/protobuf
export OPENCODE_OTLP_HEADERS="Authorization=Basic <base64-instance-id:api-key>"

# Langfuse (OTLP/HTTP only; gRPC is not supported by Langfuse)
export OPENCODE_OTLP_ENDPOINT="https://cloud.langfuse.com/api/public/otel"
export OPENCODE_OTLP_PROTOCOL=http/protobuf
export OPENCODE_OTLP_HEADERS="Authorization=Basic <base64-public-key:secret-key>,x-langfuse-ingestion-version=4"
export OPENCODE_SEMCONV=gen_ai   # langfuse maps gen_ai.* natively and infers generation spans
```

Langfuse's attribute mapping also reads `input.value` / `output.value`, so the default `openinference` dialect works; `gen_ai` additionally gets `gen_ai.usage.*` and a spec-shaped message list. Two settings change what Langfuse can show: `OPENCODE_CAPTURE_CONTEXT_SNAPSHOT=1` attaches the full request, and omitting a zero cost lets Langfuse price the model itself.
