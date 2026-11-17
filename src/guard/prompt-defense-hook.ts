// otel.guard — prompt defense hook handler.
// Optional, off by default. Scores the model-visible system prompt and emits a
// prompt_defense log event (no prompt text is ever recorded). When injection is
// explicitly enabled, appends the 10 governance context lines before scoring.

import { SeverityNumber } from "@opentelemetry/api-logs"
import { evaluatePromptDefense, isDefenseBlocking, PRODUCTION_GUARD_CONTEXT } from "./prompt-defense.ts"
import { signalAttrs } from "../semconv.ts"
import type { HandlerContext, PluginLogger } from "../types.ts"

/** Minimal shape of a `session.hook("context")` event used by this handler. */
export type PromptDefenseContextEvent = {
  sessionID: string
  agent?: string
  system: Array<{ type: string; text?: string; [key: string]: unknown }>
}

/** Prompt defense options resolved from config. */
export type PromptDefenseOptions = {
  minGrade: string
  injectContext: boolean
  failMode: "fail_open" | "fail_closed"
}

function systemText(event: PromptDefenseContextEvent): string {
  return (event.system ?? [])
    .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
}

/**
 * Score the model-visible system prompt and emit a `prompt_defense` event.
 * Never throws: a scoring or telemetry failure must not block the model request.
 */
export async function handlePromptDefense(
  event: PromptDefenseContextEvent,
  ctx: HandlerContext,
  options: PromptDefenseOptions,
  log: PluginLogger,
): Promise<void> {
  try {
    if (options.injectContext) {
      const present = new Set(systemText(event).split("\n"))
      for (const line of PRODUCTION_GUARD_CONTEXT) {
        if (!present.has(line)) event.system.push({ type: "text", text: line })
      }
    }
    const report = evaluatePromptDefense(systemText(event))
    const blocking = isDefenseBlocking(report, options.minGrade)
    ctx.emitEvent({
      severityNumber: blocking ? SeverityNumber.WARN : SeverityNumber.INFO,
      severityText: blocking ? "WARN" : "INFO",
      timestamp: Date.now(),
      body: "prompt_defense",
      attributes: {
        "event.name": "prompt_defense",
        "prompt_defense.grade": report.grade,
        "prompt_defense.score": report.score,
        "prompt_defense.coverage": report.coverage,
        "prompt_defense.defended": report.defended,
        "prompt_defense.total": report.total,
        "prompt_defense.missing": report.missing,
        "prompt_defense.prompt_hash": report.promptHash,
        "prompt_defense.injected": options.injectContext,
        "prompt_defense.blocking": blocking,
        ...signalAttrs(ctx.semconv, { sessionID: event.sessionID }),
        ...ctx.commonAttrs,
      },
    })
    if (blocking) {
      await log(options.failMode === "fail_closed" ? "error" : "warn", "guard: prompt defense below minimum grade", {
        grade: report.grade, minGrade: options.minGrade, coverage: report.coverage, missing: report.missing,
      })
    }
  } catch (e) {
    await log("debug", "guard: prompt defense error", { error: e instanceof Error ? e.message : String(e) })
  }
}
