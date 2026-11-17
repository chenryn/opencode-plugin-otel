# opencode-plugin-otel

[![npm version](https://img.shields.io/npm/v/@chenryn/opencode-plugin-otel.svg)](https://www.npmjs.com/package/@chenryn/opencode-plugin-otel)
[![npm downloads](https://img.shields.io/npm/dm/@chenryn/opencode-plugin-otel.svg)](https://www.npmjs.com/package/@chenryn/opencode-plugin-otel)
[![GitHub stars](https://img.shields.io/github/stars/chenryn/opencode-plugin-otel.svg)](https://github.com/chenryn/opencode-plugin-otel/stargazers)
[![Build status](https://img.shields.io/github/actions/workflow/status/chenryn/opencode-plugin-otel/release-please.yml?branch=main)](https://github.com/chenryn/opencode-plugin-otel/actions/workflows/release-please.yml)
[![Discord notifications](https://img.shields.io/badge/discord-notifications-5865F2?logo=discord&logoColor=white)](https://discord.gg/zavuskz8xB)
[![License](https://img.shields.io/npm/l/@chenryn/opencode-plugin-otel.svg)](https://github.com/chenryn/opencode-plugin-otel/blob/main/LICENSE)

An [OpenCode](https://opencode.ai) plugin that does two things, both off by default:

1. **OpenTelemetry export** — traces, metrics, and log events over OTLP (gRPC or HTTP/protobuf), mirroring the signal set of [Claude Code's monitoring](https://code.claude.com/docs/en/monitoring-usage).
2. **A built-in runtime guard** (`otel.guard`) — opt-in policy evaluation, a tamper-evident audit chain, tool-input/output controls, and prompt-injection blocking, reusing the same telemetry pipeline.

> **OpenCode V2 only.** The `2.x` line targets OpenCode `>=2` and exports the V2 `Plugin.define`-style default export (`id: "chenryn.otel"`). The V1 plugin lives on the [`v1` branch](https://github.com/chenryn/opencode-plugin-otel/tree/v1).

## Contents

- [Overview](#overview)
  - [Two independent capabilities](#two-independent-capabilities)
  - [Three startup modes](#three-startup-modes)
  - [OpenCode version support](#opencode-version-support)
- [How it works](#how-it-works)
  - [Signal pipeline](#signal-pipeline)
  - [Trace model](#trace-model)
  - [Guard decision path](#guard-decision-path)
  - [Hook ordering](#hook-ordering)
  - [Prompt defense vs. injection detection](#prompt-defense-vs-injection-detection)
- [What it emits](#what-it-emits)
  - [Metrics](#metrics)
  - [Traces](#traces)
  - [Log events](#log-events)
  - [Content, facts, and errors](#content-facts-and-errors)
- [Runtime guard](#runtime-guard)
  - [Decision matrix](#decision-matrix)
  - [Policy files](#policy-files)
  - [Positive allowlist](#positive-allowlist)
  - [Tool hooks](#tool-hooks)
  - [Audit chain](#audit-chain)
  - [Prompt defense (advisory)](#prompt-defense-advisory)
  - [Injection blocking (enforceable)](#injection-blocking-enforceable)
  - [Guard observability](#guard-observability)
- [Configuration](#configuration)
  - [Precedence and boolean semantics](#precedence-and-boolean-semantics)
  - [Telemetry configuration](#telemetry-configuration)
  - [Plugin options](#plugin-options)
  - [Guard configuration](#guard-configuration)
  - [Quick start](#quick-start)
  - [Headers and resource attributes](#headers-and-resource-attributes)
  - [Host and deployment identity](#host-and-deployment-identity)
  - [Dynamic headers](#dynamic-headers)
  - [Model-visible context capture](#model-visible-context-capture)
  - [LLM trace propagation](#llm-trace-propagation)
  - [Semantic conventions](#semantic-conventions)
  - [Disabling signals](#disabling-signals)
  - [Multi-instance consistency](#multi-instance-consistency)
  - [Backend examples](#backend-examples)
- [Installation](#installation)
- [Local development](#local-development)
- [GitHub Discord notifications](#github-discord-notifications)

## Overview

### Two independent capabilities

**Telemetry** observes OpenCode and exports OTel signals. It never changes what the model or tools do. It is enabled with `OPENCODE_ENABLE_TELEMETRY` (or `enabled: true`).

**The guard** makes policy decisions and can enforce them. It is enabled with `OPENCODE_GUARD_ENABLED` (or `guardEnabled: true`) and is a superset of nothing — it does not require telemetry. Individual guard features (audit, tool hooks, injection blocking, prompt scoring) are each separately opt-in.

The two share a configuration fingerprint: all telemetry options must be identical across plugin instances in one process, but **guard options may differ per project**, because guard never touches the shared OTel SDK.

### Three startup modes

| `enabled` | `guardEnabled` | Behavior |
|-----------|----------------|----------|
| `false` | `false` | No-op; the plugin logs that telemetry is disabled and returns. |
| `false` | `true` | **Guard-only.** Policy decisions are enforced and audited to disk; logging goes to the server console. No OTel SDK is created, so no signals are exported. `permission.evaluate`, tool hooks, and injection blocking all work; prompt-defense scoring (a `context` hook registered later in setup) does not run in this mode. |
| `true` | either | Full telemetry. The guard, if enabled, uses the OTel pipeline for its own events and metrics. |

### OpenCode version support

| Plugin line | OpenCode | Config key | Entrypoint |
|-------------|----------|------------|------------|
| `2.x` (`main`) | V2 (`>=2`) | `plugins` | default export `{ id, setup }` |
| `1.x` (`v1` branch) | V1 | `plugin` | named `OtelPlugin` export |

V2 replaced the coarse V1 message events (`message.updated`, `message.part.updated`) and removed `command.executed` and `session.diff` from the plugin event stream. It adds `permission.asked` / `permission.replied` in place of V1's `permission.updated`, plus a granular session taxonomy (`session.execution.*`, `session.step.*`, `session.tool.*`, `session.usage.updated`, `session.retry.scheduled`). This plugin consumes the V2 stream directly for more accurate LLM and tool span timings.

**V1 signal parity:** `lines_of_code.count` / `lines_of_code.total` depended on `session.diff` and are not emitted — the V2 plugin context does not expose a per-session diff endpoint. `command.executed` instrumentation is replaced by successful shell-tool completion. Message/part spans are replaced by per-step LLM spans; completed text segments still populate `output.value` and `llm.output_messages`.

When an unambiguous child session ID is available from subagent tool progress or result metadata, the child run span nests under its dispatch tool span. Ambiguous correlations fall back to the parent run span. Both sides carry `parent_tool_call_id` as a join key; the run span also carries `parent_session_id`.

## How it works

### Signal pipeline

OpenCode's V2 event stream and hooks feed handlers that maintain per-session trace state and emit three signal types through a shared OTel SDK:

```
event stream / hooks  ──▶  handlers/*  ──▶  span + metric + log event
                                             │
                                             └─▶  OTLP exporter (grpc | http/protobuf | http/json)
```

The SDK is acquired once per process and reference-counted. Providers are never shut down, so a plugin reload can reuse them. Exporters are rebuilt on authentication failure when a dynamic-header helper is configured, and the failed batch is retried once. A TCP probe (5 s timeout) runs against the endpoint on startup; a failure is logged, not fatal.

Event processing is serialized so an asynchronous session lookup cannot reorder step start/end events. Event attributes prefer the observed session's project ID.

### Trace model

Each user turn produces a run span; each LLM request a child span; each tool call a child of its step:

```
run span  ({prefix}session / invoke_agent)
├── LLM step span  ({prefix}llm / chat)        [SpanKind.CLIENT]
└── tool span  ({prefix}tool.{name} / execute_tool)
    └── subagent run span  (nested when correlatable)
```

Span names and attribute keys follow either the OpenInference dialect (default) or the GenAI dialect — see [Semantic conventions](#semantic-conventions). Spans are never `activate`d; parentage is passed explicitly via context objects, and log events are stamped with the target span's trace/span id. This keeps correlation deterministic under concurrent sessions.

### Guard decision path

The guard registers up to three hooks, all optional except `permission.evaluate`:

```
session.prompt          ── scan user input ──────────────┐
                                                        │ (may throw to block)
tool.execute.before     ── stage typed args              │
                        ── check positive allowlist      │
                                                        ▼
permission.evaluate     ── evaluators ─▶ decision ─▶ effect (allow / ask / deny)
                           ├ rules
                           └ tool-allowlist (only when flagged)
                        ── write audit entry
                        ── emit policy.decision
                                                        │
tool.execute.after      ── redact output / audit errors ─┘
```

**Evaluators run independently.** Each is wrapped in `try/catch`: a throwing evaluator becomes a fail-closed `deny` candidate attributed to its id, without hiding the others. Candidates merge by precedence `deny > review > warn > allow > passthrough`; on a tie, a candidate carrying a real rule wins over a generic fail-closed candidate. The `rules` evaluator is always installed; `tool-allowlist` is added only when the before hook flagged a violation.

The guard never throws from the decision path — it changes `event.effect`. For `ask`, OpenCode's own permission engine takes over (see [Hook ordering](#hook-ordering)).

### Hook ordering

Understanding the order explains two design choices:

1. **`tool.execute.before` runs before the tool's own `permission.assert`**, which is where `permission.evaluate` fires. The before hook stages the structured `input` by tool call id (`event.id`) in a bounded (512 entries), 5-minute-TTL map. When the permission event arrives with `source: { type: "tool", id }`, the guard looks up that call and uses the real typed arguments for `command_regex` matching, shell analysis, and the audit digest. Calls without a tool source fall back to the flattened `resources` strings. The after hook removes the staged entry by the same call id.
2. **`effect: "ask"` is a real server-side decision.** In enforce mode, a `review` verdict with base effect `allow` becomes `ask`. OpenCode then pauses the tool call and runs its normal `permission.asked` → `permission.replied` flow. The guard does not implement an approval UI; it only raises `allow` to `ask` and relaxes an existing `ask` to `allow` when a rule permits. It never tightens an existing `ask` or `deny`. (Earlier AGT guidance that plugins cannot issue a server-side `ask` applied to the V1 hook contract; V2 supports it.)

### Prompt defense vs. injection detection

These are different mechanisms and are deliberately kept separate:

| | Prompt defense | Injection detection |
|---|---|---|
| Scans | The **system prompt** (model-visible `event.system`) | The **user prompt** (`event.prompt.text`) |
| Method | 12 OWASP-aligned defense vectors; each vector's regex hits produce a coverage score and grade (A ≥ 90 … F ≥ 0) | 9 specific attack signatures (instruction override, role takeover, fake `<system>` tags, prompt-leak requests, jailbreak, plus Chinese variants) and zero-width / homoglyph obfuscation |
| Hook | `session.hook("context")`, only when telemetry is fully enabled | `session.hook("prompt")`, registered inside `setupGuard` (works in guard-only mode) |
| Blocks? | **Never.** Emits `prompt_defense` with a `blocking` attribute and log level; catches all errors. | Only when `guardPromptInjectionBlock` + `enforce` + a finding at or above `guardPromptInjectionMinSeverity` → throws `PromptInjectionBlocked`. |
| Records | Hash + grade + vector ids; never prompt text | Hash + finding ids + severity; never prompt text |

**Why defense grade cannot gate requests:** it measures how many *defensive instructions* a prompt contains. A normal user request scores 0/12 (F), so using that grade to block would deny every normal prompt. Blocking is therefore driven by the separate attack-signature detector. Its patterns are intentionally specific — "ignore network errors", "handle `system:` prefixes", and "act as a judge" all produce zero findings.

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
| Span type key | `openinference.span.kind` = `AGENT`/`LLM`/`TOOL` | `gen_ai.operation.name` = `invoke_agent`/`chat`/`execute_tool` |

The full attribute mapping — session/agent/model/provider identity, input/output message shapes, token and cost keys, tool call fields, turn/step correlation, and error fields — is in [Semantic conventions](#semantic-conventions).

### Log events

| Event | Description |
|-------|-------------|
| `session.created` | Session started |
| `session.idle` | Session went idle (totals for tokens, cost, messages) |
| `session.error` | Execution failed |
| `user_prompt` | User prompt durably admitted via `session.inbox.enqueued` (`prompt_length`, `delivery`; also `prompt` when `OPENCODE_CAPTURE_PROMPT_IN_LOGS` is set) |
| `api_request` | Completed LLM step (tokens, cost) |
| `api_error` | Failed LLM step (structured error) |
| `tool_result` | Tool completed or errored (duration, success, output size) |
| `permission.requested` | Permission prompt asked (`permission.action`, `permission.resources`, `request.id`, `target.tool_call.id`, `target.span.id`) |
| `tool_decision` | Permission answered (accept/reject), with the same correlation keys; never records a policy verdict |
| `commit` | Git commit detected |
| `subtask_invoked` | Sub-agent session created (agent and parent session id) |
| `policy.decision` | Guard verdict per `permission.evaluate` (opt-in) |
| `guard.tool.before` / `guard.tool.after` | Tool staging, allowlist verdict, output redaction, failed-call audit (opt-in) |
| `guard.prompt.injection` | User-prompt injection finding: ids, severity, hash, blocked flag — never prompt text (opt-in) |
| `prompt_defense` | System-prompt defense coverage: grade, score, finding ids — never prompt text (opt-in) |

In the `gen_ai` dialect, `session.created`, `api_request`, `api_error`, and `tool_result` duplicate a span that already carries the same information. They are emitted by default so an audit timeline keeps every lifecycle marker; set `OPENCODE_EMIT_REDUNDANT_EVENTS=0` to suppress them when spans and events feed the same backend. Other events keep their `event.name` schema but use GenAI identity keys (`gen_ai.conversation.id`, `gen_ai.agent.name`, `gen_ai.request.model`, `gen_ai.provider.name`, `gen_ai.tool.name`); `session.id` remains the cross-signal join key in both dialects.

### Content, facts, and errors

Every failure event (`api_error`, `session.error`, `tool_result` with `success=false`, rejected `tool_decision`) carries a structured error: `error.type` is the grouping key, with `error.message` and `error.status` preserved. A rejected permission records `permission.decision=reject` with `error.type=permission_denied` — it reports the fact only and never enforces policy.

Tool spans and `tool_result` events carry a **fact layer**, emitted even when content capture is off: `tool.command` (verbatim shell command) and `file.operation` / `file.path` / `file.paths` (`read`, `write`, `edit`, `list`, `glob`, `search`). Set `OPENCODE_CAPTURE_TOOL_FACTS=0` to suppress it when raw commands must not leave the host. The passive telemetry path writes no judgement fields; detection and enforcement belong to the opt-in guard.

Content-bearing attributes are capped at 20,000 characters. A truncated value carries `<field>.truncated=true` and `<field>.original_length` (`tool.arguments`, `tool.result`, `content.output`, `content.input`, `prompt`, `tool.command`); counters such as `prompt_length` and `tool.result_size_bytes` always report the original size. A cut multi-path list also reports `file.paths.truncated` and `file.paths.original_count`.

## Runtime guard

All guard features are off unless `guardEnabled` is set. Decisions are resolved through isolated evaluators; telemetry failures never affect enforcement, and the decision path never awaits or throws on observability.

**Origin.** `otel.guard` is an original, dependency-free implementation inspired by
[Microsoft's Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit)
(AGT, MIT). Concretely borrowed: the fail-closed evaluator pattern (`deniedBy` attribution),
RFC 8785 canonical JSON and the hash-chained audit shape from AGT's `lib/audit.mjs`,
`PromptDefenseEvaluator`'s 12-vector scoring model, and the literal injection-pattern tables
from its MCP scanner. AGT's PolicyEngine backend system, server-side approval flow, and
standalone MCP scanner were **not** adopted — OpenCode V2's `permission.evaluate` already
provides a real server-side `ask`, and the guard reuses this plugin's telemetry pipeline
instead of shipping its own.

### Decision matrix

Evaluator verdicts merge by precedence `deny > review > warn > allow > passthrough`, then resolve against the mode and the base effect OpenCode already decided:

| Verdict | `monitor_only` | `enforce` |
|---------|----------------|-----------|
| `allow` | effect unchanged, `allowed` | base `ask` → `allow` (relaxed-from-ask); otherwise unchanged |
| `warn` | effect unchanged, `warned` | unchanged in every mode — never blocks |
| `review` | effect unchanged, `review` | base `allow` → `ask` (raised-from-allow); base `ask`/`deny` unchanged |
| `deny` | effect unchanged, `would_denied` | effect → `deny`, `denied` |
| no match | effect unchanged, `passthrough` | unchanged |

`monitor_only` is a shadow mode: deny hits are labelled `would_denied` but never mutate the effect. `enforce` never relaxes a `deny` and never tightens an existing `ask`.

If the decision path itself throws outside an evaluator (for example, the policy is not loaded), `failMode` decides: `fail_closed` returns `effect: "deny"` with decision `degraded`; `fail_open` keeps the base effect, also `degraded`. An evaluator throwing is always a fail-closed deny candidate, independent of `failMode`.

### Policy files

`guardPolicyPath` points to a JSON file, hot-reloaded with a non-persistent watcher and last-good retention (a bad reload keeps the previous policy and logs a warning).

```json
{
  "version": "v1",
  "settings": {
    "mode": "monitor_only",
    "fail_mode": "fail_open",
    "unmatched": "passthrough"
  },
  "rules": [
    {
      "id": "deny-rm-rf",
      "name": "Destructive recursive delete",
      "type": "deny",
      "severity": "high",
      "description": "Blocks rm -rf against any path",
      "tools": ["bash", "shell"],
      "match": { "command_regex": "\\brm\\s+-[a-z]*r[a-z]*f\\b" }
    }
  ]
}
```

- `id` must be non-empty and match `[\w.\-]+`; `name` and `type` are required. `type` is `allow`, `deny`, `review`, or `warn`.
- `tools` filters by lowercased tool name; omitted or empty means all tools. `severity` defaults to `medium`.
- A rule needs at least one matcher: `command_regex` (case-insensitive by default) and/or `resource_contains` (lower-cased substring). `command_regex_flags` accepts only `i` and `u` — the stateful/multiline `g`/`y`/`m`/`s` flags are rejected, as are empty sources, sources over 2,048 characters, and patterns that match the empty string.
- `version_sha256` is `sha256:` plus the hash of the raw document in RFC 8785 canonical JSON, so reordering keys does not create a false version change.
- `guardMode` and `guardFailMode` (option or env) override the file's `settings.mode` / `settings.fail_mode` entirely. Default when neither source provides a value: `monitor_only` / `fail_open`.

### Positive allowlist

When `guardToolAllowlistPath` exists, tools with an entry accept only matching commands or URLs. A missing or invalid file leaves the feature passive; no tool is constrained by default. The file is hot-reloaded and uses the same canonical hash for its version.

```json
{
  "version": "v1",
  "tools": {
    "bash": { "command_prefixes": ["ls ", "pwd", "git status"] },
    "webfetch": { "url_prefixes": ["https://github.com/", "https://registry.npmjs.org/"] }
  }
}
```

Prefixes are case-insensitive (`startsWith`), capped at 256 entries of 2,048 characters each, and lowercased on load. Shell tools are checked against `command_prefixes`; fetch-like tools (`webfetch`, `fetch`, `http`, `curl`) against `url_prefixes`. Tools with no entry are not allowlisted. A violation is a deny candidate at `permission.evaluate` (`tool-allowlist`), following the same mode and audit rules as a policy deny.

### Tool hooks

`guardToolHooks` registers the V2 `tool.execute.before` and `tool.execute.after` hooks. These are single-object mutable hooks: `before` sees structured `input`, and `after` sees a mutable `result` or an `error`. Both are fail-open — a hook error is logged but never changes the tool outcome.

- **Structured-argument staging.** `before` stores typed input by call id for the permission decision and audit digest (see [Hook ordering](#hook-ordering)).
- **Output redaction.** With `guardToolRedact` plus `guardMode: "enforce"`, `after` replaces known credentials in `result.content` with `[REDACTED:<pattern>]` before the model sees them: AWS access keys, GitHub PATs, OpenAI keys, JWTs, PEM private keys, and Azure storage keys. In `monitor_only` the same patterns are reported as `would_redact` but never mutated. Only the event's `result` object changes — never the on-disk tool output.
- **Failed-call audit.** `after` records a `tool_error` audit entry with a bounded error excerpt when a call reports `status: "error"`, covering failures that never reach an output hook.

### Audit chain

`guardAuditEnabled` appends a tamper-evident entry for every decision (and for tool errors / redactions when the tool hooks are on).

Each v2 entry carries `v`, `timestamp`, `agentId` (`opencode:<sessionID>`), `action`, `decision`, `previousHash`, `hash`, and optional `policyVersion`, `reason`, `argsDigest`, `argsDigestAlg`, `argsTruncated`, `argsUnserializable`, and `principal`. The hash covers every other field via RFC 8785 canonical JSON; `previousHash` links to the chain head (`"0"*64` for a new chain). Verification walks the chain with a constant-time hash compare and rejects version downgrades.

- The chain keeps the most recent 10,000 entries. On rollover the last evicted hash is retained as `seamHash`, so the surviving head still anchors to something verifiable.
- Argument digests are SHA-256 by default, or HMAC-SHA256 when `OPENCODE_GUARD_AUDIT_HMAC_KEY` (≥32 UTF-8 bytes) is set. Payloads over 1 MiB are truncated and flagged; unserializable values use a sentinel.
- Writes are serialized through a single queue and committed atomically (temp file + rename), never awaited on the decision path. A broken chain or fs error only logs — enforcement is unaffected.
- A short HMAC key disables the entire audit with an error log.

### Prompt defense (advisory)

`guardPromptDefense` scores the model-visible system prompt against 12 OWASP-aligned defense vectors and emits `prompt_defense` with `grade`, `score`, `coverage`, `defended`, `total`, `missing`, and `prompt_hash` — never the prompt text. A finding below `guardPromptDefenseMinGrade` (default `B`) only raises the log level; it never blocks.

`guardPromptDefenseInjectContext` idempotently appends ten governance instructions to the system prompt before scoring. The bundled context scores A (12/12). Injection changes what the model sees, so roll it out separately from enforcement. This hook runs only when telemetry is fully enabled (not in guard-only mode).

### Injection blocking (enforceable)

`guardPromptInjectionBlock` registers a `session.prompt` hook that scans **user input** for attack signatures and can stop the request before it reaches the model. It blocks only when all three conditions hold: the option is on, `guardMode` is `enforce`, and a finding meets `guardPromptInjectionMinSeverity` (default `high`; obfuscation-only findings count as `medium`). Every finding — blocked or not — emits `guard.prompt.injection` with finding ids, severity, and a hash. On a scan error, `failMode` decides whether to block (`fail_closed`) or log only (`fail_open`). This is the guard's only throw-based block.

### Guard observability

Every `permission.evaluate` emits `policy.decision` with the verdict, mode, base/effective effect, policy hash, matched rule ids, a bounded resource excerpt, shell analysis for shell actions (`shell.obfuscated`, `shell.atoms_count`, `shell.dangerous_ops`, `shell.injection_patterns`, `shell.zero_width`, `shell.homoglyph`, `shell.safe_cleanup`), deny attribution (`policy.denied_by`, `policy.errored_evaluators`), audit markers, and tool-span correlation when the call is already traced. Denials in enforce mode also surface as `session.tool.failed` events so the tool span records the interception.

Guard counters: `opencode.guard.decisions` (attribute `policy.decision`, `policy.mode`, `permission.action`, optionally `policy.rule_id` and `policy.denied_by`) and `opencode.guard.tool.actions` (`guard.tool.action`, `tool_name`).

## Configuration

Configuration comes from `OPENCODE_*` environment variables and/or inline plugin options. An option wins over its env variable, which wins over the built-in default.

### Precedence and boolean semantics

Two boolean conventions coexist — worth knowing when scripting configuration:

- Most flags (`enabled`, `capturePromptInLogs`, `captureModelContext`, and all guard booleans except `guardEmitUnmatched`) use "non-empty means true": values like `"0"` or `"false"` still **enable** the flag.
- `captureToolFacts`, `emitRedundantEvents`, and `guardEmitUnmatched` use opt-out parsing: unset/empty → enabled; `0`, `false`, `no`, `off` → disabled; any other non-empty value → enabled.
- `logsEnabled` is driven by the inverse env `OPENCODE_DISABLE_LOGS`: presence (even `=false`) disables OTLP logs.
- An explicitly invalid option usually falls through to the env value, with a warning for `semconv` and `metricsTemporality`. Two exceptions keep the default instead: `guardPromptDefenseMinGrade` and `guardPromptInjectionMinSeverity`.

### Telemetry configuration

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
| `OPENCODE_CAPTURE_PROMPT_IN_LOGS` | *(unset)* | Non-empty includes full prompt text in `user_prompt` logs — sensitive; trusted collectors only |
| `OPENCODE_CAPTURE_TOOL_FACTS` | enabled | `0`/`false`/`no`/`off` suppresses verbatim commands and file paths |
| `OPENCODE_CAPTURE_MODEL_CONTEXT` | *(unset)* | Non-empty attaches a bounded text-only preview of model context to LLM spans |
| `OPENCODE_DISABLE_TRACES` | *(unset)* | Comma-separated `session`, `llm`, `tool`; `all`/`*`/`true`/`1` disables all |
| `OPENCODE_OTLP_HEADERS` | *(unset)* | Comma-separated `key=value` headers for all exports — may contain secrets |
| `OPENCODE_OTLP_HEADERS_HELPER` | *(unset)* | Executable returning dynamic headers as JSON after an auth failure |
| `OPENCODE_RESOURCE_ATTRIBUTES` | *(unset)* | Comma-separated `key=value` pairs on the OTel Resource |
| `OPENCODE_SPAN_ATTRIBUTES` | *(unset)* | Comma-separated `key=value` pairs on spans, logs, and metric points |
| `OPENCODE_OTLP_METRICS_TEMPORALITY` | *(unset)* | `delta`, `cumulative`, or `lowmemory`; required for Datadog |
| `OPENCODE_TRACEPARENT` / `OPENCODE_TRACESTATE` | *(unset)* | W3C remote parent context for all spans |
| `OPENCODE_TRACE_PROPAGATION_PROVIDERS` | *(unset)* | Provider IDs that receive W3C trace headers on LLM requests; `*` for all |
| `OPENCODE_SEMCONV` | `openinference` | `openinference` or `gen_ai` |
| `OPENCODE_EMIT_REDUNDANT_EVENTS` | enabled | `0`/`false`/`no`/`off` drops gen_ai log events that duplicate a span |

### Plugin options

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
| `emitRedundantEvents` | `OPENCODE_EMIT_REDUNDANT_EVENTS` | |
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

> `opencode.json` is often committed to version control. Keep secrets in an environment variable or an opencode `{env:VAR}` substitution (for example `"otlpHeaders": "{env:OTEL_HEADERS}"`).

### Guard configuration

| Option | Environment variable | Default | Description |
|--------|----------------------|---------|-------------|
| `guardEnabled` | `OPENCODE_GUARD_ENABLED` | `false` | Master switch |
| `guardMode` | `OPENCODE_GUARD_MODE` | policy → `monitor_only` | `monitor_only` (shadow) or `enforce` |
| `guardFailMode` | `OPENCODE_GUARD_FAIL_MODE` | policy → `fail_open` | `fail_open` or `fail_closed` on internal error |
| `guardPolicyPath` | `OPENCODE_GUARD_POLICY_PATH` | `~/.config/opencode/otel-guard-policy.json` | Policy JSON |
| `guardEmitUnmatched` | `OPENCODE_GUARD_EMIT_UNMATCHED` | `true` | Emit `passthrough` events for unmatched evaluations |
| `guardAuditEnabled` | `OPENCODE_GUARD_AUDIT_ENABLED` | `false` | Hash-chained decision audit |
| `guardAuditPath` | `OPENCODE_GUARD_AUDIT_PATH` | `~/.config/opencode/otel-guard-audit.json` | Audit chain path |
| `guardPromptDefense` | `OPENCODE_GUARD_PROMPT_DEFENSE` | `false` | Score system-prompt defense coverage (advisory) |
| `guardPromptDefenseMinGrade` | `OPENCODE_GUARD_PROMPT_DEFENSE_MIN_GRADE` | `B` | Grade threshold for the WARN log |
| `guardPromptDefenseInjectContext` | `OPENCODE_GUARD_PROMPT_DEFENSE_INJECT` | `false` | Append 10 governance lines to the system prompt |
| `guardToolHooks` | `OPENCODE_GUARD_TOOL_HOOKS` | `false` | Register `execute.before`/`after`: staging, allowlist, redaction, error audit |
| `guardToolAllowlistPath` | `OPENCODE_GUARD_TOOL_ALLOWLIST_PATH` | `~/.config/opencode/otel-guard-tool-allowlist.json` | Positive allowlist JSON (passive when absent) |
| `guardToolRedact` | `OPENCODE_GUARD_TOOL_REDACT` | `false` | Redact known credentials from tool output in enforce mode |
| `guardPromptInjectionBlock` | `OPENCODE_GUARD_PROMPT_INJECTION_BLOCK` | `false` | Scan and optionally block user-prompt injection |
| `guardPromptInjectionMinSeverity` | `OPENCODE_GUARD_PROMPT_INJECTION_MIN_SEVERITY` | `high` | `critical`, `high`, or `medium` |

Three values are **env-only** and cannot be set through plugin options, so tool arguments or model output cannot forge an identity: `OPENCODE_GUARD_PRINCIPAL_SUB`, `OPENCODE_GUARD_PRINCIPAL_ISS`, and `OPENCODE_GUARD_AUDIT_HMAC_KEY` (≥32 bytes; a short key disables the audit chain).

### Quick start

```bash
export OPENCODE_ENABLE_TELEMETRY=1
export OPENCODE_OTLP_ENDPOINT=http://localhost:4317
export OPENCODE_OTLP_PROTOCOL=grpc
opencode
```

To enable the guard in shadow mode on top of telemetry:

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

Move `guardMode` to `enforce` only after reviewing `policy.decision` events under `monitor_only`.

### Headers and resource attributes

```bash
export OPENCODE_OTLP_HEADERS="x-honeycomb-team=your-api-key,x-honeycomb-dataset=opencode"
export OPENCODE_RESOURCE_ATTRIBUTES="service.version=1.2.3,deployment.environment=production"
export OPENCODE_SPAN_ATTRIBUTES="team=platform,deployment.environment=production"
```

`OPENCODE_RESOURCE_ATTRIBUTES` sets producer metadata on the OTel Resource; `OPENCODE_SPAN_ATTRIBUTES` adds filterable attributes to every span, log, and metric point. They are independent.

### Host and deployment identity

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

### Dynamic headers

`OPENCODE_OTLP_HEADERS_HELPER` points to an executable that prints dynamic headers as JSON. The plugin prewarms it at startup and refreshes headers on an auth failure (`401`/`403`, or `UNAUTHENTICATED`/`PERMISSION_DENIED`), rebuilding the exporter and retrying once. Helper headers override static headers of the same name; header values are never logged.

```bash
export OPENCODE_OTLP_HEADERS_HELPER='${PROJECT_ROOT}/scripts/opencode-otel-headers.sh'
```

Placeholders `${PROJECT_ROOT}`, `${WORKTREE}`, and `${DIRECTORY}` are expanded. The helper must print a JSON object, for example:

```sh
#!/bin/sh
printf '{"Authorization":"Bearer %s"}' "$(gcloud auth print-identity-token)"
```

### Model-visible context capture

```bash
export OPENCODE_CAPTURE_MODEL_CONTEXT=1
```

Captures up to two system parts and the last twelve messages, text only, each truncated to 1,000 characters, into the matching primary LLM span (`llm.input_messages`, with the latest user text also in `input.value`). Under `OPENCODE_SEMCONV=gen_ai`, the same flag also gates every content-bearing GenAI attribute that the conventions mark Opt-In (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, and the `prompt` log attribute). Media bytes and structured tool payloads are never copied. The hook observes context at its position in plugin order; later plugins can still change the request. Use only with a trusted collector.

### LLM trace propagation

```bash
export OPENCODE_TRACE_PROPAGATION_PROVIDERS="company-litellm,vllm"
```

For matching provider IDs, the plugin injects the active LLM span as W3C `traceparent` (and `tracestate` when present) so traces join spans emitted by an LLM gateway. Propagation is limited to primary agent-loop requests whose provider, model, and agent match the active step; title, compaction, and transient generations are not parented. Values are OpenCode provider IDs; `*` enables all providers. Only W3C trace context is injected — no arbitrary headers or baggage. For WebSocket-backed providers, the plugin also injects on the experimental `experimental.ws.handshake` hook; enabling it can reopen reused sockets, so verify against your provider.

### Semantic conventions

`OPENCODE_SEMCONV` (or `semconv`) selects the wire dialect for spans, metrics, and log events together. `openinference` is the default and what existing dashboards query; `gen_ai` targets GenAI-native backends. Aliases: `open-inference` → `openinference`, `gen-ai`/`genai` → `gen_ai`. An unrecognized value warns and falls back to `openinference`.

| Aspect | `openinference` (default) | `gen_ai` |
|--------|---------------------------|----------|
| Identity | `session.id`, `agent.name`, `llm.model_name` / `llm.provider` | `gen_ai.conversation.id` (+ `session.id`), `gen_ai.agent.name`, `gen_ai.request.model` / `gen_ai.response.model`, `gen_ai.provider.name` |
| Input | `input.value`, `llm.input_messages` as `[{role, content}]` | `gen_ai.input.messages` as `[{role, parts:[{type:"text", content}]}]` |
| Output | `output.value`, `llm.output_messages` | `gen_ai.output.messages` |
| Tokens | `llm.token_count.prompt` / `.completion` / `.total`, plus cache details | `gen_ai.usage.input_tokens` (prompt + cache), `.output_tokens` (completion + reasoning), separate cache/read counters, `gen_ai.token.modality` |
| Finish reason | `llm.finish_reason` (string) | `gen_ai.response.finish_reasons` (array) |
| Cost | `llm.cost.total`, `cost_usd` | `gen_ai.usage.cost`, `session.total_cost_usd` |
| Tool call | `tool.id`, `tool.name`, `tool.parameters` | `gen_ai.tool.call.id`, `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` |
| Correlation | — | `gen_ai.turn.id` and `gen_ai.step.id` (plugin extensions) |
| Errors | span status + `llm.finish_reason` + `error.type` / `.message` / `.status` | span status + `error.type` / `.message` / `.status` |

`gen_ai.token.modality` is `text` for output tokens and `unknown` for prompt/cache tokens, because OpenCode receives one aggregate prompt count. Turn ids are `<sessionID>:<sequence>`, strictly increasing per session; a tool span carries the same turn id plus the owning assistant message id as `gen_ai.step.id`. OpenCode-specific attributes (`agent.type`, `session.is_subagent`, `parent_session_id`, `parent_tool_call_id`, retry fields, session totals, `tool.success`, `tool.error`, `tool.result_size_bytes`, error fields, subagent agent, and anything from `OPENCODE_SPAN_ATTRIBUTES`) are emitted in both dialects.

### Disabling signals

`OPENCODE_DISABLE_METRICS` takes comma-separated metric suffixes without the prefix; disabling a metric stops increments but leaves its log events intact. Under `gen_ai`, list GenAI metrics by full name.

```bash
export OPENCODE_DISABLE_METRICS="cache.count,session.duration,retry.count"
export OPENCODE_DISABLE_LOGS=1
export OPENCODE_DISABLE_TRACES="llm,tool"
```

The following are OpenCode-only and have no Claude Code equivalent, so disable them when using a Claude Code dashboard: `cache.count`, `session.duration`, `session.token.total`, `session.cost.total`, `model.usage`, `retry.count`, `message.count`, `exporter.*`, `event.dispatch.errors`, `flush.*`. For full dashboard compatibility also set `OPENCODE_METRIC_PREFIX=claude_code.`.

### Multi-instance consistency

When several plugin instances load in one process (global plus project config), all **telemetry** options must be identical. A different endpoint, authentication, resource attribute, prefix, or signal option fails setup rather than exporting one location's data with another's settings. The fingerprint covers all telemetry fields with the three set-valued fields sorted; `logLevel` and the entire `guard` config are excluded, so projects may enable different guard features while sharing one OTel SDK. Process-wide shared event processing is serialized for deterministic ordering.

### Backend examples

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
```

## Installation

Install from GitHub (no npm account needed). Add this to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:chenryn/opencode-plugin-otel"]
}
```

OpenCode installs the package on first start and reloads it on config changes. Other
valid targets are a branch, tag, full commit hash, or a subdirectory selector:

```json
{
  "plugins": [
    "github:chenryn/opencode-plugin-otel#main",
    "git+ssh://git@github.com/chenryn/opencode-plugin-otel.git#main"
  ]
}
```

You can also install and update it with the CLI:

```bash
opencode plugin add github:chenryn/opencode-plugin-otel
opencode plugin list
opencode plugin update github:chenryn/opencode-plugin-otel
```

To pass options, use the object form (the `package` field is the npm name declared in
`package.json`; OpenCode resolves it to the same plugin regardless of how it was installed):

```json
{
  "plugins": [
    {
      "package": "@chenryn/opencode-plugin-otel",
      "options": { "enabled": true, "guardEnabled": true }
    }
  ]
}
```

The plugin's runtime **ID** is `chenryn.otel` — use it to disable or re-enable the plugin
with the `plugins` control syntax (`"-chenryn.otel"`, `"chenryn.*"`). If you also have a
fork with a different ID, keep them distinct to avoid OpenCode's duplicate-ID error.

Once `@chenryn/opencode-plugin-otel` is published to npm, it can be installed by name:

```json
{
  "plugins": ["@chenryn/opencode-plugin-otel"]
}
```

For local development, install dependencies with `bun install` and create `.opencode/plugins/otel/index.ts` in the project where OpenCode runs:

```ts
export { default } from "/path/to/opencode-plugin-otel/src/index.ts"
```

OpenCode V2 discovers this directory automatically. On OpenCode `2.0.1`, a `plugins` entry pointing directly to an absolute `.ts` file is rejected — the package loader expects a directory.

## Local development

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## GitHub Discord notifications

This repo includes a reusable workflow at `.github/workflows/discord-notify.yml` that posts a Discord embed for `issues.opened`, `pull_request.opened`, and `release.published`. Set a repository or org secret named `DISCORD_WEBHOOK` to enable it.

To reuse it from another repository under the same account:

```yaml
name: Discord Events
on:
  issues:
    types: [opened]
  pull_request:
    types: [opened]
  release:
    types: [published]
jobs:
  notify-discord:
    uses: chenryn/opencode-plugin-otel/.github/workflows/discord-notify.yml@main
    with:
      username: chenryn Bot
      title_prefix: "[chenryn]"
      include_body: true
    secrets:
      discord_webhook: ${{ secrets.DISCORD_WEBHOOK }}
```

Workflow inputs: `username`, `avatar_url`, `title_prefix`, `include_body`, and `color`.
