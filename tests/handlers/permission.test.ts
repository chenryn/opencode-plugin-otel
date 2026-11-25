import { describe, test, expect } from "bun:test"
import { handlePermissionAsked, handlePermissionReplied } from "../../src/handlers/permission.ts"
import { makeCtx, evt } from "../helpers.ts"

describe("handlePermissionAsked", () => {
  test("stores the pending permission", () => {
    const { ctx } = makeCtx()
    handlePermissionAsked(evt("permission.asked", { id: "perm_1", sessionID: "ses_1", action: "bash", resources: ["git push"] }), ctx)
    expect(ctx.tracing.pendingPermissions.get("perm_1")!.action).toBe("bash")
  })
})

describe("handlePermissionReplied", () => {
  test("emits an accept tool_decision", () => {
    const { ctx, logger } = makeCtx()
    handlePermissionAsked(evt("permission.asked", { id: "perm_1", sessionID: "ses_1", action: "bash", resources: ["git push"] }), ctx)
    handlePermissionReplied(evt("permission.replied", { sessionID: "ses_1", requestID: "perm_1", reply: "always" }), ctx)
    const record = logger.records.at(-1)!
    expect(record.body).toBe("tool_decision")
    expect(record.attributes?.["decision"]).toBe("accept")
    expect(record.attributes?.["tool_name"]).toBe("bash")
    expect(record.attributes?.["source"]).toBe("always")
  })

  test("emits a reject tool_decision", () => {
    const { ctx, logger } = makeCtx()
    handlePermissionAsked(evt("permission.asked", { id: "perm_2", sessionID: "ses_1", action: "edit", resources: ["a.ts"] }), ctx)
    handlePermissionReplied(evt("permission.replied", { sessionID: "ses_1", requestID: "perm_2", reply: "reject" }), ctx)
    const record = logger.records.at(-1)!
    expect(record.attributes?.["decision"]).toBe("reject")
    expect(record.attributes?.["permission.decision"]).toBe("reject")
    expect(record.attributes?.["error.type"]).toBe("permission_denied")
    expect(record.attributes?.["error.message"]).toBe("edit rejected")
  })

  test("an accepted decision carries no error attributes", () => {
    const { ctx, logger } = makeCtx()
    handlePermissionAsked(evt("permission.asked", { id: "perm_3", sessionID: "ses_1", action: "edit", resources: ["a.ts"] }), ctx)
    handlePermissionReplied(evt("permission.replied", { sessionID: "ses_1", requestID: "perm_3", reply: "once" }), ctx)
    const record = logger.records.at(-1)!
    expect(record.attributes?.["permission.decision"]).toBe("accept")
    expect(record.attributes?.["error.type"]).toBeUndefined()
  })

  test("records how long the user took to answer", () => {
    const { ctx, logger } = makeCtx()
    handlePermissionAsked(evt("permission.asked", { id: "perm_4", sessionID: "ses_1", action: "bash", resources: ["git push"] }, 1_000), ctx)
    handlePermissionReplied(evt("permission.replied", { sessionID: "ses_1", requestID: "perm_4", reply: "once" }, 3_500), ctx)
    const record = logger.records.at(-1)!
    expect(record.attributes?.["permission.wait_ms"]).toBe(2_500)
  })

  test("never records a negative wait when the reply precedes the prompt", () => {
    const { ctx, logger } = makeCtx()
    handlePermissionAsked(evt("permission.asked", { id: "perm_5", sessionID: "ses_1", action: "bash", resources: ["git push"] }, 5_000), ctx)
    handlePermissionReplied(evt("permission.replied", { sessionID: "ses_1", requestID: "perm_5", reply: "once" }, 4_000), ctx)
    const record = logger.records.at(-1)!
    expect(record.attributes?.["permission.wait_ms"]).toBe(0)
  })

  test("omits the wait when the prompt was never observed", () => {
    const { ctx, logger } = makeCtx()
    handlePermissionReplied(evt("permission.replied", { sessionID: "ses_1", requestID: "perm_6", reply: "once" }, 3_500), ctx)
    const record = logger.records.at(-1)!
    expect(record.attributes?.["permission.wait_ms"]).toBeUndefined()
  })
})

describe("permission.requested", () => {
  const spanContext = { traceId: "0".repeat(32), spanId: "abcdef0123456789", traceFlags: 1 }

  test("emits the request with its resources and target correlation", () => {
    const { ctx, logger } = makeCtx()
    ctx.tracing.toolSpanContexts.set("call_1", spanContext)
    handlePermissionAsked(evt("permission.asked", {
      id: "perm_1",
      sessionID: "ses_1",
      action: "bash",
      resources: ["git push"],
      source: { type: "tool", messageID: "msg_1", id: "call_1" },
    }), ctx)
    const record = logger.records.at(-1)!
    expect(record.body).toBe("permission.requested")
    expect(record.attributes?.["permission.action"]).toBe("bash")
    expect(record.attributes?.["permission.resources"]).toEqual(["git push"])
    expect(record.attributes?.["request.id"]).toBe("perm_1")
    expect(record.attributes?.["target.tool_call.id"]).toBe("call_1")
    expect(record.attributes?.["target.span.id"]).toBe("abcdef0123456789")
    expect(ctx.tracing.pendingPermissions.get("perm_1")!.toolCallID).toBe("call_1")
  })

  test("omits target attributes when the source is missing", () => {
    const { ctx, logger } = makeCtx()
    handlePermissionAsked(evt("permission.asked", { id: "perm_2", sessionID: "ses_1", action: "edit", resources: ["a.ts"] }), ctx)
    const record = logger.records.at(-1)!
    expect(record.attributes?.["request.id"]).toBe("perm_2")
    expect(record.attributes?.["target.tool_call.id"]).toBeUndefined()
    expect(record.attributes?.["target.span.id"]).toBeUndefined()
  })

  test("tool_decision reuses the correlation and the GenAI resource array", () => {
    const { ctx, logger } = makeCtx("proj_test", [], [], true, {}, "gen_ai")
    ctx.tracing.toolSpanContexts.set("call_1", spanContext)
    handlePermissionAsked(evt("permission.asked", {
      id: "perm_1",
      sessionID: "ses_1",
      action: "bash",
      resources: ["git push", "git status"],
      source: { type: "tool", messageID: "msg_1", id: "call_1" },
    }), ctx)
    handlePermissionReplied(evt("permission.replied", { sessionID: "ses_1", requestID: "perm_1", reply: "once" }), ctx)
    const record = logger.records.at(-1)!
    expect(record.body).toBe("tool_decision")
    expect(record.attributes?.["request.id"]).toBe("perm_1")
    expect(record.attributes?.["permission.action"]).toBe("bash")
    expect(record.attributes?.["permission.resources"]).toEqual(["git push", "git status"])
    expect(record.attributes?.["target.span.id"]).toBe("abcdef0123456789")
    expect(record.attributes?.["resources"]).toBeUndefined()
  })

  test("openinference keeps the legacy resources string", () => {
    const { ctx, logger } = makeCtx()
    handlePermissionAsked(evt("permission.asked", { id: "perm_1", sessionID: "ses_1", action: "bash", resources: ["git push", "git status"] }), ctx)
    handlePermissionReplied(evt("permission.replied", { sessionID: "ses_1", requestID: "perm_1", reply: "always" }), ctx)
    const record = logger.records.at(-1)!
    expect(record.attributes?.["resources"]).toBe("git push,git status")
    expect(record.attributes?.["permission.resources"]).toBeUndefined()
  })
})
