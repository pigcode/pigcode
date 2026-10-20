/** 验证侧栏渲染项目与会话。 */
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { WorkspaceSidebar } from "./workspace-sidebar"

describe("WorkspaceSidebar", () => {
  it("renders projects and threads", () => {
    render(
      <LocaleProvider locale="zh-CN">
        <WorkspaceSidebar
          projects={[
            {
              id: "p1",
              rootPath: "/tmp/demo",
              name: "demo",
              createdAt: "2026-10-20T00:00:00.000Z",
            },
          ]}
          threads={[
            {
              id: "t1",
              projectId: "p1",
              title: "First thread",
              defaultProviderId: "fake",
              lastProviderId: null,
              lastModelId: null,
              permissionMode: "workspace-write",
              createdAt: "2026-10-20T00:00:00.000Z",
              updatedAt: "2026-10-20T00:00:00.000Z",
              archivedAt: null,
              lastRunId: null,
            },
          ]}
          activeThreadId="t1"
          expandedProjects={{ p1: true }}
          onAddProject={() => {}}
          onToggleProject={() => {}}
          onOpenThread={() => {}}
          onNewThread={() => {}}
          onOpenSettings={() => {}}
        />
      </LocaleProvider>,
    )
    expect(screen.getByText("demo")).toBeTruthy()
    expect(screen.getByText("First thread")).toBeTruthy()
  })
})
