# opencode-plugin-otel

[![npm version](https://img.shields.io/npm/v/@chenryn/opencode-plugin-otel.svg)](https://www.npmjs.com/package/@chenryn/opencode-plugin-otel)
[![npm downloads](https://img.shields.io/npm/dm/@chenryn/opencode-plugin-otel.svg)](https://www.npmjs.com/package/@chenryn/opencode-plugin-otel)
[![GitHub stars](https://img.shields.io/github/stars/chenryn/opencode-plugin-otel.svg)](https://github.com/chenryn/opencode-plugin-otel/stargazers)
[![Build status](https://img.shields.io/github/actions/workflow/status/chenryn/opencode-plugin-otel/release-please.yml?branch=main)](https://github.com/chenryn/opencode-plugin-otel/actions/workflows/release-please.yml)
[![Discord notifications](https://img.shields.io/badge/discord-notifications-5865F2?logo=discord&logoColor=white)](https://discord.gg/zavuskz8xB)
[![License](https://img.shields.io/npm/l/@chenryn/opencode-plugin-otel.svg)](https://github.com/chenryn/opencode-plugin-otel/blob/main/LICENSE)

[OpenCode](https://opencode.ai) observability and runtime governance, in one plugin. Both capabilities are off by default.

- **Telemetry** exports traces, metrics, and log events over OTLP (gRPC or HTTP) to any backend — mirroring [Claude Code's monitoring](https://code.claude.com/docs/en/monitoring-usage) signal set, with OpenInference and GenAI dialects.
- **`otel.guard`** evaluates policy on every tool permission, keeps a tamper-evident audit chain, and can block prompt injection. It works with or without telemetry.

> OpenCode V2 only. The `2.x` line targets OpenCode `>=2`; the V1 plugin lives on the [`v1` branch](https://github.com/chenryn/opencode-plugin-otel/tree/v1).

## Quick start

**1. Install** in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:chenryn/opencode-plugin-otel"]
}
```

**2. Export telemetry:**

```bash
export OPENCODE_ENABLE_TELEMETRY=1
export OPENCODE_OTLP_ENDPOINT=http://localhost:4317   # or https://…/api/public/otel
export OPENCODE_OTLP_PROTOCOL=grpc                    # http/protobuf for most SaaS backends
opencode
```

**3. Optionally enable the guard** (start in shadow mode, review, then enforce):

```json
{
  "plugins": [
    {
      "package": "@chenryn/opencode-plugin-otel",
      "options": {
        "enabled": true,
        "guardEnabled": true,
        "guardPolicyPath": "./otel-guard-policy.json"
      }
    }
  ]
}
```

## What you get

```text
run span (session / invoke_agent)
├── LLM step span (llm / chat)          tokens, cost, finish reason, reasoning
├── compaction span                     context rewrites and their cost
└── tool span (tool.name / execute_tool)
    └── subagent run span               nested when correlatable
```

- **Traces** — run/LLM/tool/compaction spans with deterministic parentage; trace identity survives a plugin reload.
- **Metrics** — tokens, cost, tool latency, TTFT, retries, cache, sessions, export health (or the official `gen_ai.*` metric set).
- **Log events** — session, prompt, step, tool, permission, compaction, and guard decisions.
- **Privacy controls** — content is opt-in and truncated; verbatim commands and file paths can be suppressed; full-context snapshots are a separate, off-by-default switch.
- **Guard** — `allow`/`ask`/`deny` decisions, shadow mode, policy files, positive allowlists, credential redaction, and an HMAC-secured audit chain.

## Documentation

| Document | Contents |
|----------|----------|
| [docs/installation.md](./docs/installation.md) | Install variants, plugin ID, local development install |
| [docs/configuration.md](./docs/configuration.md) | Every env var and plugin option, headers, resource attributes, dynamic headers |
| [docs/telemetry.md](./docs/telemetry.md) | Signal pipeline, trace model, metric/trace/log reference, semantic conventions, backends |
| [docs/guard.md](./docs/guard.md) | Decision path, policy files, allowlist, tool hooks, audit chain, injection blocking |
| [docs/development.md](./docs/development.md) | Tests, release process, Discord notification workflow |

## Compatibility

| Item | Value |
|------|-------|
| OpenCode | V2 (`>=2`), config key `plugins`, default export `{ id, setup }` |
| OTLP | `grpc`, `http/protobuf`, `http/json` |
| Backends | SigNoz, Datadog, Honeycomb, Grafana, Langfuse, OpenTelemetry Collector, and anything else speaking OTLP |
| Plugin ID | `chenryn.otel` |

Backend snippets and dialect notes are in [docs/telemetry.md](./docs/telemetry.md#backend-examples).

## Security notes

Telemetry is passive and writes no judgement fields. Prompt text and full model context are opt-in; verbatim tool commands and file paths are collection defaults but can be suppressed with `OPENCODE_CAPTURE_TOOL_FACTS=0`. Guard principals and the audit HMAC key are env-only, so tool arguments or model output cannot forge them. Details: [telemetry privacy](./docs/telemetry.md#content-and-privacy) and [guard audit](./docs/guard.md#audit-chain).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MPL-2.0](./LICENSE).
