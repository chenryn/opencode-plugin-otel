# Runtime guard

`otel.guard` evaluates policy on every tool permission decision and can enforce it. Everything here is off unless `OPENCODE_GUARD_ENABLED` (or `guardEnabled: true`) is set; individual features are separately opt-in.

The guard does not require telemetry. With `enabled: false` and `guardEnabled: true` it runs in **guard-only mode**: decisions are enforced and audited to disk, logging goes to the server console, and no OTel SDK is created. `permission.evaluate`, tool hooks, and injection blocking all work; prompt-defense scoring does not (its `context` hook belongs to the telemetry setup).

- [Origin](#origin)
- [Decision path](#decision-path)
- [Hook ordering](#hook-ordering)
- [Decision matrix](#decision-matrix)
- [Policy files](#policy-files)
- [Positive allowlist](#positive-allowlist)
- [Tool hooks](#tool-hooks)
- [Audit chain](#audit-chain)
- [Prompt defense vs. injection detection](#prompt-defense-vs-injection-detection)
- [Prompt defense (advisory)](#prompt-defense-advisory)
- [Injection blocking (enforceable)](#injection-blocking-enforceable)
- [Guard observability](#guard-observability)
- [Configuration](#configuration)

## Origin

`otel.guard` is an original, dependency-free implementation inspired by
[Microsoft's Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit)
(AGT, MIT). Concretely borrowed: the fail-closed evaluator pattern (`deniedBy` attribution),
RFC 8785 canonical JSON and the hash-chained audit shape from AGT's `lib/audit.mjs`,
`PromptDefenseEvaluator`'s 12-vector scoring model, and the literal injection-pattern tables
from its MCP scanner. AGT's PolicyEngine backend system, server-side approval flow, and
standalone MCP scanner were **not** adopted — OpenCode V2's `permission.evaluate` already
provides a real server-side `ask`, and the guard reuses this plugin's telemetry pipeline
instead of shipping its own.

## Decision path

The guard registers up to three hooks, all optional except `permission.evaluate`:

```text
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

## Hook ordering

Understanding the order explains two design choices:

1. **`tool.execute.before` runs before the tool's own `permission.assert`**, which is where `permission.evaluate` fires. The before hook stages the structured `input` by tool call id (`event.id`) in a bounded (512 entries), 5-minute-TTL map. When the permission event arrives with `source: { type: "tool", id }`, the guard looks up that call and uses the real typed arguments for `command_regex` matching, shell analysis, and the audit digest. Calls without a tool source fall back to the flattened `resources` strings. The after hook removes the staged entry by the same call id.
2. **`effect: "ask"` is a real server-side decision.** In enforce mode, a `review` verdict with base effect `allow` becomes `ask`. OpenCode then pauses the tool call and runs its normal `permission.asked` → `permission.replied` flow. The guard does not implement an approval UI; it only raises `allow` to `ask` and relaxes an existing `ask` to `allow` when a rule permits. It never tightens an existing `ask` or `deny`. (Earlier AGT guidance that plugins cannot issue a server-side `ask` applied to the V1 hook contract; V2 supports it.)

## Decision matrix

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

## Policy files

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

## Positive allowlist

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

## Tool hooks

`guardToolHooks` registers the V2 `tool.execute.before` and `tool.execute.after` hooks. These are single-object mutable hooks: `before` sees structured `input`, and `after` sees a mutable `result` or an `error`. Both are fail-open — a hook error is logged but never changes the tool outcome.

- **Structured-argument staging.** `before` stores typed input by call id for the permission decision and audit digest (see [Hook ordering](#hook-ordering)).
- **Output redaction.** With `guardToolRedact` plus `guardMode: "enforce"`, `after` replaces known credentials in `result.content` with `[REDACTED:<pattern>]` before the model sees them: AWS access keys, GitHub PATs, OpenAI keys, JWTs, PEM private keys, and Azure storage keys. In `monitor_only` the same patterns are reported as `would_redact` but never mutated. Only the event's `result` object changes — never the on-disk tool output.
- **Failed-call audit.** `after` records a `tool_error` audit entry with a bounded error excerpt when a call reports `status: "error"`, covering failures that never reach an output hook.

## Audit chain

`guardAuditEnabled` appends a tamper-evident entry for every decision (and for tool errors / redactions when the tool hooks are on).

Each v2 entry carries `v`, `timestamp`, `agentId` (`opencode:<sessionID>`), `action`, `decision`, `previousHash`, `hash`, and optional `policyVersion`, `reason`, `argsDigest`, `argsDigestAlg`, `argsTruncated`, `argsUnserializable`, and `principal`. The hash covers every other field via RFC 8785 canonical JSON; `previousHash` links to the chain head (`"0"*64` for a new chain). Verification walks the chain with a constant-time hash compare and rejects version downgrades.

- The chain keeps the most recent 10,000 entries. On rollover the last evicted hash is retained as `seamHash`, so the surviving head still anchors to something verifiable.
- Argument digests are SHA-256 by default, or HMAC-SHA256 when `OPENCODE_GUARD_AUDIT_HMAC_KEY` (≥32 UTF-8 bytes) is set. Payloads over 1 MiB are truncated and flagged; unserializable values use a sentinel.
- Writes are serialized through a single queue and committed atomically (temp file + rename), never awaited on the decision path. A broken chain or fs error only logs — enforcement is unaffected.
- A short HMAC key disables the entire audit with an error log.

## Prompt defense vs. injection detection

These are different mechanisms and are deliberately kept separate:

| | Prompt defense | Injection detection |
|---|---|---|
| Scans | The **system prompt** (model-visible `event.system`) | The **user prompt** (`event.prompt.text`) |
| Method | 12 OWASP-aligned defense vectors; each vector's regex hits produce a coverage score and grade (A ≥ 90 … F ≥ 0) | 9 specific attack signatures (instruction override, role takeover, fake `<system>` tags, prompt-leak requests, jailbreak, plus Chinese variants) and zero-width / homoglyph obfuscation |
| Hook | `session.hook("context")`, only when telemetry is fully enabled | `session.hook("prompt")`, registered inside `setupGuard` (works in guard-only mode) |
| Blocks? | **Never.** Emits `prompt_defense` with a `blocking` attribute and log level; catches all errors. | Only when `guardPromptInjectionBlock` + `enforce` + a finding at or above `guardPromptInjectionMinSeverity` → throws `PromptInjectionBlocked`. |
| Records | Hash + grade + vector ids; never prompt text | Hash + finding ids + severity; never prompt text |

**Why defense grade cannot gate requests:** it measures how many *defensive instructions* a prompt contains. A normal user request scores 0/12 (F), so using that grade to block would deny every normal prompt. Blocking is therefore driven by the separate attack-signature detector. Its patterns are intentionally specific — "ignore network errors", "handle `system:` prefixes", and "act as a judge" all produce zero findings.

## Prompt defense (advisory)

`guardPromptDefense` scores the model-visible system prompt against 12 OWASP-aligned defense vectors and emits `prompt_defense` with `grade`, `score`, `coverage`, `defended`, `total`, `missing`, and `prompt_hash` — never the prompt text. A finding below `guardPromptDefenseMinGrade` (default `B`) only raises the log level; it never blocks.

`guardPromptDefenseInjectContext` idempotently appends ten governance instructions to the system prompt before scoring. The bundled context scores A (12/12). Injection changes what the model sees, so roll it out separately from enforcement. This hook runs only when telemetry is fully enabled (not in guard-only mode).

## Injection blocking (enforceable)

`guardPromptInjectionBlock` registers a `session.prompt` hook that scans **user input** for attack signatures and can stop the request before it reaches the model. It blocks only when all three conditions hold: the option is on, `guardMode` is `enforce`, and a finding meets `guardPromptInjectionMinSeverity` (default `high`; obfuscation-only findings count as `medium`). Every finding — blocked or not — emits `guard.prompt.injection` with finding ids, severity, and a hash. On a scan error, `failMode` decides whether to block (`fail_closed`) or log only (`fail_open`). This is the guard's only throw-based block.

## Guard observability

Every `permission.evaluate` emits `policy.decision` with the verdict, mode, base/effective effect, policy hash, matched rule ids, a bounded resource excerpt, shell analysis for shell actions (`shell.obfuscated`, `shell.atoms_count`, `shell.dangerous_ops`, `shell.injection_patterns`, `shell.zero_width`, `shell.homoglyph`, `shell.safe_cleanup`), deny attribution (`policy.denied_by`, `policy.errored_evaluators`), audit markers, and tool-span correlation when the call is already traced. Denials in enforce mode also surface as `session.tool.failed` events so the tool span records the interception.

Guard counters: `opencode.guard.decisions` (attribute `policy.decision`, `policy.mode`, `permission.action`, optionally `policy.rule_id` and `policy.denied_by`) and `opencode.guard.tool.actions` (`guard.tool.action`, `tool_name`).

## Configuration

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

Guard options may differ per project even when several plugin instances share one process: the telemetry configuration fingerprint excludes them.

### Example

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
