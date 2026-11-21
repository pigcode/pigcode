/** 侧栏组件测试共用的项目、会话、渲染和原生右键菜单替身。 */
import { act, fireEvent, render, type RenderResult } from "@testing-library/react"
import type { ComponentProps } from "react"
import { vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { ToastProvider } from "./toast"
import { WorkspaceSidebar } from "./workspace-sidebar"

export const project = (id: string, name: string) => ({
  id,
  rootPath: `/tmp/${name}`,
  name,
  createdAt: "2026-10-20T00:00:00.000Z",
})

export const thread = (
  id: string,
  projectId: string,
  title: string,
  updatedAt: string,
  patch: { archivedAt?: string; unread?: boolean } = {},
) => ({
  id,
  projectId,
  title,
  defaultAgentId: "claude",
  defaultInstanceId: null,
  lastAgentId: null,
  lastInstanceId: null,
  lastModelId: null,
  permissionMode: "workspace-write" as const,
  createdAt: updatedAt,
  updatedAt,
  archivedAt: null as string | null,
  lastRunId: null,
  ...patch,
})

export function renderSidebar(
  props: Partial<ComponentProps<typeof WorkspaceSidebar>> = {},
): RenderResult {
  return render(
    <LocaleProvider locale="zh-CN">
      <ToastProvider>
        <WorkspaceSidebar
          projects={[project("p1", "alpha")]}
          threads={[thread("t1", "p1", "First thread", "2026-10-20T01:00:00.000Z")]}
          activeThreadId={null}
          expandedProjects={{}}
          onAddProject={() => {}}
          onToggleProject={() => {}}
          onOpenThread={() => {}}
          onNewThread={() => {}}
          {...props}
        />
      </ToastProvider>
    </LocaleProvider>,
  )
}

/** 用替身代替 preload 暴露的原生桥。 */
export function mockNative(value: Partial<NonNullable<Window["pigcodeNative"]>>): void {
  Object.defineProperty(window, "pigcodeNative", { configurable: true, value })
}

type PopupMenu = NonNullable<NonNullable<Window["pigcodeNative"]>["popupMenu"]>

export function mockMenu(overrides?: Partial<NonNullable<Window["pigcodeNative"]>>) {
  const popupMenu = vi.fn<PopupMenu>().mockResolvedValue(null)
  mockNative({ platform: "linux", ...overrides, popupMenu })
  return popupMenu
}

export async function chooseMenuItem(
  menu: ReturnType<typeof mockMenu>,
  target: HTMLElement,
  id: string,
) {
  menu.mockResolvedValueOnce(id)
  await act(async () => {
    fireEvent.contextMenu(target)
  })
}
