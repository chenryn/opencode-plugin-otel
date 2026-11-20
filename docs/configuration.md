# Configuration

Configuration comes from `OPENCODE_*` environment variables and/or inline plugin options. An option wins over its env variable, which wins over the built-in default.

- [Startup modes](#startup-modes)
- [Precedence and boolean semantics](#precedence-and-boolean-semantics)
- [Telemetry variables](#telemetry-variables)
- [Plugin options](#plugin-options)
- [Headers and resource attributes](#headers-and-resource-attributes)
- [Host and deployment identity](#host-and-deployment-identity)
- [Dynamic headers](#dynamic-headers)

Guard options are documented in [guard.md](./guard.md#configuration).

## Startup modes

| `enabled` | `guardEnabled` | Behavior |
|-----------|----------------|----------|
| `false` | `false` | No-op; the plugin logs that telemetry is disabled and returns. |
| `false` | `true` | **Guard-only.** Decisions are enforced and audited to disk; logging goes to the server console. No OTel SDK is created, so no signals are exported. `permission.evaluate`, tool hooks, and injection blocking work; prompt-defense scoring does not. |
| `true` | either | Full telemetry. The guard, if enabled, uses the OTel pipeline for its own events and metrics. |

Telemetry never changes what the model or tools do. The guard can enforce, but only through OpenCode's own permission machinery (see [guard.md](./guard.md)).

## Precedence and boolean semantics

Two boolean conventions coexist — worth knowing when scripting configuration:

- Most flags (`enabled`, `capturePromptInLogs`, `captureModelContext`, `captureContextSnapshot`, and all guard booleans except `guardEmitUnmatched`) use "non-empty means true": values like `"0"` or `"false"` still **enable** the flag.
- `captureToolFacts`, `emitRedundantEvents`, and `guardEmitUnmatched` use opt-out parsing: unset/empty → enabled; `0`, `false`, `no`, `off` → disabled; any other non-empty value → enabled.
- `logsEnabled` is driven by the inverse env `OPENCODE_DISABLE_LOGS`: presence (even `=false`) disables OTLP logs.
- An explicitly invalid option usually falls through to the env value, with a warning for `semconv` and `metricsTemporality`. Two exceptions keep the default instead: `guardPromptDefenseMinGrade` and `guardPromptInjectionMinSeverity`.

## Telemetry variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_ENABLE_TELEMETRY` | *(unset)* | Non-empty enables the plugin |
| `OPENCODE_OTLP_ENDPOINT` | `http://localhost:4317` | Full URL with scheme. For `http/*`, the plugin appends `/v1/traces`, `/v1/metrics`, `/v1/logs` |
| `OPENCODE_OTLP_PROTOCOL` | `grpc` | `grpc`, `http/protobuf`, or `http/json` |
| `OPENCODE_OTLP_METRICS_INTERVAL` | `60000` | Metrics export interval in ms |
| `OPENCODE_OTLP_LOGS_INTERVAL` | `5000` | Log batch delay in ms |
| `OPENCODE_METRIC_PREFIX` | `opencode.` | Prefix for metric names and span names; also used for Claude Code dashboard compatibility |
| `OPENCODE_DISABLE_METRICS` | *(unset)* | Comma-separated metric suffixes (no prefix) |
| `OPENCODE_DISABLE_LOGS` | *(unset)* | Non-empty suppresses all OTLP log events |
| `OPENCODE_DISABLE_TRACES` | *(unset)* | Comma-separated `session`, `llm`, `tool`; `all`/`*`/`true`/`1` disables all. Compaction spans follow `llm` |
| `OPENCODE_CAPTURE_PROMPT_IN_LOGS` | *(unset)* | Non-empty includes full prompt text in `user_prompt` logs — sensitive; trusted collectors only |
| `OPENCODE_CAPTURE_TOOL_FACTS` | enabled | `0`/`false`/`no`/`off` suppresses verbatim commands and file paths |
| `OPENCODE_CAPTURE_MODEL_CONTEXT` | *(unset)* | Non-empty attaches a bounded text-only preview of model context to LLM spans |
| `OPENCODE_CAPTURE_CONTEXT_SNAPSHOT` | *(unset)* | Non-empty attaches the full model-visible context (system prompt, messages, tool definitions) to LLM spans — sensitive |
| `OPENCODE_OTLP_HEADERS` | *(unset)* | Comma-separated `key=value` headers for all exports — may contain secrets |
| `OPENCODE_OTLP_HEADERS_HELPER` | *(unset)* | Executable returning dynamic headers as JSON after an auth failure |
| `OPENCODE_RESOURCE_ATTRIBUTES` | *(unset)* | Comma-separated `key=value` pairs on the OTel Resource |
| `OPENCODE_SPAN_ATTRIBUTES` | *(unset)* | Comma-separated `key=value` pairs on spans, logs, and metric points |
| `OPENCODE_OTLP_METRICS_TEMPORALITY` | *(unset)* | `delta`, `cumulative`, or `lowmemory`; required for Datadog |
| `OPENCODE_TRACEPARENT` / `OPENCODE_TRACESTATE` | *(unset)* | W3C remote parent context for all spans |
| `OPENCODE_TRACE_PROPAGATION_PROVIDERS` | *(unset)* | Provider IDs that receive W3C trace headers on LLM requests; `*` for all |
| `OPENCODE_SEMCONV` | `openinference` | `openinference` or `gen_ai` |
| `OPENCODE_AGENT_VERSION` | app version | Agent runtime version emitted as `gen_ai.agent.version`; set it when the agent definition has its own version |
| `OPENCODE_EMIT_REDUNDANT_EVENTS` | enabled | `0`/`false`/`no`/`off` drops gen_ai log events that duplicate a span |
| `OPENCODE_LOCAL_EVENT_LOG` | enabled | Mirror emitted log events to a local JSONL file |
| `OPENCODE_LOCAL_EVENT_LOG_PATH` | `~/.local/share/opencode/otel-log-events.jsonl` | Destination of the local mirror |

## Plugin options

Every telemetry setting can be passed inline through the plugin object form. Keys mirror the resolved config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@chenryn/opencode-plugin-otel",
      "options": {
        "enabled": true,
        "endpoint": "http://localhost:4317",
        "protocol": "grpc",
        "metricPrefix": "claude_code.",
        "resourceAttributes": "service.version=1.2.3,deployment.environment=production",
        "disabledTraces": ["tool"]
      }
    }
  ]
}
```

| Option | Environment variable | Notes |
|--------|----------------------|-------|
| `enabled` | `OPENCODE_ENABLE_TELEMETRY` | |
| `logsEnabled` | `OPENCODE_DISABLE_LOGS` (inverted) | |
| `capturePromptInLogs` | `OPENCODE_CAPTURE_PROMPT_IN_LOGS` | |
| `captureToolFacts` | `OPENCODE_CAPTURE_TOOL_FACTS` | |
| `captureModelContext` | `OPENCODE_CAPTURE_MODEL_CONTEXT` | |
| `captureContextSnapshot` | `OPENCODE_CAPTURE_CONTEXT_SNAPSHOT` | |
| `emitRedundantEvents` | `OPENCODE_EMIT_REDUNDANT_EVENTS` | |
| `localEventLog` / `localEventLogPath` | `OPENCODE_LOCAL_EVENT_LOG` / `OPENCODE_LOCAL_EVENT_LOG_PATH` | |
| `logLevel` | *(option only)* | `debug`, `info`, `warn`, `error`; invalid → `info` |
| `endpoint` | `OPENCODE_OTLP_ENDPOINT` | |
| `protocol` | `OPENCODE_OTLP_PROTOCOL` | |
| `metricsInterval` / `logsInterval` | `OPENCODE_OTLP_METRICS_INTERVAL` / `OPENCODE_OTLP_LOGS_INTERVAL` | |
| `metricPrefix` | `OPENCODE_METRIC_PREFIX` | |
| `otlpHeaders` / `otlpHeadersHelper` | `OPENCODE_OTLP_HEADERS` / `OPENCODE_OTLP_HEADERS_HELPER` | Prefer `{env:VAR}` substitution over inline secrets |
| `resourceAttributes` / `spanAttributes` | `OPENCODE_RESOURCE_ATTRIBUTES` / `OPENCODE_SPAN_ATTRIBUTES` | |
| `traceparent` / `tracestate` | `OPENCODE_TRACEPARENT` / `OPENCODE_TRACESTATE` | |
| `metricsTemporality` | `OPENCODE_OTLP_METRICS_TEMPORALITY` | |
| `disabledMetrics` / `disabledTraces` / `tracePropagationProviders` | matching `OPENCODE_*` | Arrays, not comma strings |
| `semconv` | `OPENCODE_SEMCONV` | |
| `agentVersion` | `OPENCODE_AGENT_VERSION` | Defaults to the OpenCode app version |

> `opencode.json` is often committed to version control. Keep secrets in an environment variable or an opencode `{env:VAR}` substitution (for example `"otlpHeaders": "{env:OTEL_HEADERS}"`).

## Headers and resource attributes

```bash
export OPENCODE_OTLP_HEADERS="x-honeycomb-team=your-api-key,x-honeycomb-dataset=opencode"
export OPENCODE_RESOURCE_ATTRIBUTES="service.version=1.2.3,deployment.environment=production"
export OPENCODE_SPAN_ATTRIBUTES="team=platform,deployment.environment=production"
```

`OPENCODE_RESOURCE_ATTRIBUTES` sets producer metadata on the OTel Resource; `OPENCODE_SPAN_ATTRIBUTES` adds filterable attributes to every span, log, and metric point. They are independent.

## Host and deployment identity

Set host and deployment dimensions on the **resource**, not on individual spans:

```bash
export OPENCODE_RESOURCE_ATTRIBUTES="host.name=build-07,service.instance.id=opencode-3f2a,deployment.environment.name=production,service.namespace=platform"
```

| Dimension | Recommended key | Notes |
|-----------|-----------------|-------|
| Host | `host.name` | Set explicitly by the deployer; the plugin does not guess it |
| Instance | `service.instance.id` | Unique per process |
| Environment | `deployment.environment.name` | Older backends accept `deployment.environment` |
| Namespace | `service.namespace` | Team or tenant dimension |

`project.id` is a workspace dimension derived from the observed session — not a user identity. The plugin never infers user identity; map source IPs to users in the Collector.

## Dynamic headers

`OPENCODE_OTLP_HEADERS_HELPER` points to an executable that prints dynamic headers as JSON. The plugin prewarms it at startup and refreshes headers on an auth failure (`401`/`403`, or `UNAUTHENTICATED`/`PERMISSION_DENIED`), rebuilding the exporter and retrying once. Helper headers override static headers of the same name; header values are never logged.

```bash
export OPENCODE_OTLP_HEADERS_HELPER='${PROJECT_ROOT}/scripts/opencode-otel-headers.sh'
```

Placeholders `${PROJECT_ROOT}`, `${WORKTREE}`, and `${DIRECTORY}` are expanded. The helper must print a JSON object, for example:

```sh
#!/bin/sh
printf '{"Authorization":"Bearer %s"}' "$(gcloud auth print-identity-token)"
```
