/** 验证领域实体的解析与命令参数校验。 */
import { describe, expect, it } from "vitest"
import { commandSchemas, threadSchema } from "./index"

describe("domain contracts", () => {
  it("parses a thread", () => {
    const thread = threadSchema.parse({
      id: "th_1",
      projectId: "pr_1",
      title: "First thread",
      defaultProviderId: "fake",
      lastProviderId: null,
      lastModelId: null,
      permissionMode: "workspace-write",
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
      archivedAt: null,
      lastRunId: null,
    })
    expect(thread.permissionMode).toBe("workspace-write")
  })

  it("validates run.start params", () => {
    const params = commandSchemas["run.start"].parse({ threadId: "th_1", text: "hello" })
    expect(params.threadId).toBe("th_1")
  })

  it("rejects an empty run.start text", () => {
    expect(() => commandSchemas["run.start"].parse({ threadId: "th_1", text: "" })).toThrow()
  })
})
