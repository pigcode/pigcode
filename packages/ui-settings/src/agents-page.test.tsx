/** 验证 Agent 设置页：两栏布局、实例列表、状态、启用开关、按 manifest 生成的表单、环境变量与自定义模型的保存。 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AgentSummary, AgentStatus } from "@pigcode/contracts"
import { LocaleProvider, entityMark } from "@pigcode/ui-primitives"
import { AgentsPage, type AgentsPageProps } from "./agents-page"
import { agentHeadline, instanceHeadline } from "./agent-status"

afterEach(cleanup)

const FEATURES = {
  streaming: true,
  approvals: true,
  questions: false,
  plan: true,
  resume: true,
  fork: false,
  rollback: false,
  checkpoint: false,
  subagents: false,
  mcp: true,
  images: false,
  usage: true,
  modelCatalog: true,
  nativeSessionId: true,
}

function agent(overrides: Partial<AgentSummary>): AgentSummary {
  return {
    agentId: "claude",
    displayName: "Claude Code",
    pluginId: "agent.@pigcode/agent-claude",
    version: "0.1.0",
    builtin: true,
    enabled: true,
    registered: true,
    features: FEATURES,
    description: { "zh-CN": "Claude Code CLI", "en-US": "Claude Code CLI" },
    homepage: "https://claude.com/product/claude-code",
    installHint: { "zh-CN": "安装 Claude Code", "en-US": "Install Claude Code" },
    fields: [
      {
        key: "binaryPath",
        type: "path",
        pathKind: "file",
        label: { "zh-CN": "可执行文件" },
        placeholder: "claude",
      },
      { key: "launchArgs", type: "text", monospace: true, label: { "zh-CN": "启动参数" } },
      { key: "environment", type: "env", label: { "zh-CN": "环境变量" } },
    ],
    customModels: true,
    values: {},
    error: null,
    instances: [],
    ...overrides,
  }
}

const READY: AgentStatus = {
  installed: true,
  version: "2.1.304",
  authenticated: true,
  account: "max · claude.ai",
  command: "/usr/local/bin/claude",
}

function renderPage(overrides: Partial<AgentsPageProps> = {}) {
  const props: AgentsPageProps = {
    agents: [
      agent({}),
      agent({
        agentId: "echo",
        displayName: "Echo",
        pluginId: "agent.pigcode-agent-echo",
        builtin: false,
        fields: [],
        description: null,
        homepage: null,
        installHint: null,
      }),
    ],
    defaultAgentId: null,
    defaultInstanceId: null,
    statuses: { claude: READY },
    onDetect: vi.fn(async () => undefined),
    onSetEnabled: vi.fn(async () => undefined),
    onSaveSettings: vi.fn(async () => undefined),
    onSetDefault: vi.fn(async () => undefined),
    onCreateInstance: vi.fn(async () => "inst_new"),
    onUpdateInstance: vi.fn(async () => undefined),
    onRemoveInstance: vi.fn(async () => undefined),
    onInstall: vi.fn(async () => undefined),
    onUninstall: vi.fn(async () => undefined),
    ...overrides,
  }
  render(
    <LocaleProvider locale="zh-CN">
      <AgentsPage {...props} />
    </LocaleProvider>,
  )
  return props
}

/** 选中一个实例：列表行是一整块按钮。 */
const openInstance = (label: string) =>
  userEvent.click(screen.getByRole("button", { name: `打开 ${label} 的设置` }))

describe("AgentsPage", () => {
  it("lists every instance with its status and built-in badge", () => {
    renderPage()
    // 两个 agent 的默认实例各占一行，默认实例用 agent 的名字。
    expect(screen.getByRole("button", { name: "打开 Claude Code 的设置" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "打开 Echo 的设置" })).toBeTruthy()
    expect(screen.getByText("内置")).toBeTruthy()
    // 状态在列表行与详情标题里各出现一次。
    expect(screen.getAllByText("就绪").length).toBe(2)
    expect(screen.getByText(/2\.1\.304 · max · claude\.ai/)).toBeTruthy()
    // 详情显示的是选中的 Claude Code，echo 的列表行还在检测中。
    expect(screen.getByText("检测中…")).toBeTruthy()
  })

  it("opens the first instance by default and switches with the list", async () => {
    renderPage()
    // 默认选中第一个实例，详情里就是它的字段。
    expect(screen.getByRole("textbox", { name: "启动参数" })).toBeTruthy()
    expect(screen.getByRole("heading", { level: 1, name: "Claude Code" })).toBeTruthy()

    await openInstance("Echo")
    expect(screen.getByRole("heading", { level: 1, name: "Echo" })).toBeTruthy()
    // Echo 没有声明字段，详情里只有实例卡片。
    expect(screen.queryByRole("textbox", { name: "启动参数" })).toBeNull()
  })

  it("toggles a plugin-backed agent through the instance switch", async () => {
    const props = renderPage()
    await userEvent.click(screen.getByRole("switch", { name: "启用 Echo" }))
    await waitFor(() =>
      expect(props.onSetEnabled).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "echo" }),
        false,
      ),
    )
  })

  it("edits manifest fields, environment and custom models, then saves", async () => {
    const props = renderPage()
    expect(screen.getByText("/usr/local/bin/claude")).toBeTruthy()

    await userEvent.type(screen.getByRole("textbox", { name: "可执行文件" }), "/opt/claude")
    await userEvent.type(screen.getByRole("textbox", { name: "启动参数" }), "--chrome")
    await userEvent.click(screen.getByRole("button", { name: "添加变量" }))
    await userEvent.type(screen.getByRole("textbox", { name: "变量名 1" }), "HTTPS_PROXY")
    await userEvent.type(screen.getByRole("textbox", { name: "值 1" }), "http://127.0.0.1:7890")
    // 没填名字的行保存时去掉。
    await userEvent.click(screen.getByRole("button", { name: "添加变量" }))
    const model = screen.getByRole("textbox", { name: "模型 id，例如 claude-sonnet-5" })
    await userEvent.type(model, "claude-sonnet-5{Enter}")
    await userEvent.type(model, "claude-sonnet-5{Enter}")
    expect(screen.getByText("已经添加过这个模型")).toBeTruthy()

    expect(screen.getByText("有未保存的修改")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "保存" }))
    await waitFor(() => expect(props.onSaveSettings).toHaveBeenCalledTimes(1))
    expect(props.onSaveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "claude" }),
      expect.objectContaining({ instanceId: "claude" }),
      {
        binaryPath: "/opt/claude",
        launchArgs: "--chrome",
        environment: [{ name: "HTTPS_PROXY", value: "http://127.0.0.1:7890" }],
        customModels: ["claude-sonnet-5"],
      },
    )
    expect(await screen.findByText("已保存，对之后新建的会话生效")).toBeTruthy()
  })

  it("shows the save error and keeps the draft", async () => {
    renderPage({
      onSaveSettings: vi.fn(async () => {
        throw new Error("invalid value for claude.binaryPath")
      }),
    })
    fireEvent.change(screen.getByRole("textbox", { name: "启动参数" }), {
      target: { value: "--x" },
    })
    await userEvent.click(screen.getByRole("button", { name: "保存" }))
    expect(await screen.findByText(/invalid value for claude\.binaryPath/)).toBeTruthy()
    expect((screen.getByRole("textbox", { name: "启动参数" }) as HTMLInputElement).value).toBe(
      "--x",
    )
  })

  it("offers uninstall only for user-installed agents, with a confirmation", async () => {
    const props = renderPage()
    expect(screen.queryByRole("button", { name: "卸载" })).toBeNull()
    await openInstance("Echo")
    await userEvent.click(screen.getByRole("button", { name: "卸载" }))
    await userEvent.click(screen.getByRole("button", { name: "确认卸载" }))
    await waitFor(() =>
      expect(props.onUninstall).toHaveBeenCalledWith(expect.objectContaining({ agentId: "echo" })),
    )
  })

  it("installs an agent from the dialog", async () => {
    const props = renderPage()
    await userEvent.click(screen.getByRole("button", { name: "安装 agent" }))
    await userEvent.type(
      screen.getByRole("textbox", { name: "npm 包或插件目录" }),
      "pigcode-agent-foo@1.0.0",
    )
    await userEvent.click(screen.getByRole("button", { name: "安装" }))
    await waitFor(() => expect(props.onInstall).toHaveBeenCalledWith("pigcode-agent-foo@1.0.0"))
  })

  it("sets the instance new sessions start with, including back to automatic", async () => {
    const props = renderPage({
      agents: [
        agent({
          instances: [
            {
              instanceId: "claude",
              agentId: "claude",
              label: "Claude Code",
              enabled: true,
              values: {},
              isDefault: true,
              createdAt: null,
            },
            {
              instanceId: "inst_work",
              agentId: "claude",
              label: "公司 API",
              enabled: true,
              values: {},
              isDefault: false,
              createdAt: "2026-11-01T00:00:00.000Z",
            },
          ],
        }),
      ],
      defaultInstanceId: "inst_work",
    })
    // 选择器显示实际生效的实例。
    expect(screen.getByRole("combobox", { name: "新会话使用" }).textContent).toContain("公司 API")

    await userEvent.click(screen.getByRole("combobox", { name: "新会话使用" }))
    await userEvent.click(screen.getByRole("option", { name: "自动" }))
    await waitFor(() => expect(props.onSetDefault).toHaveBeenCalledWith(null))
  })

  it("shows the empty state when no agent is installed", () => {
    renderPage({ agents: [] })
    expect(screen.getByText("还没有 agent")).toBeTruthy()
    expect(screen.getByText("安装一个 agent 插件开始使用。")).toBeTruthy()
  })

  it("creates another instance through the three-step wizard", async () => {
    const props = renderPage()
    // 默认实例不能改名或删除，详情里只说一句说明。
    expect(
      screen.getByText("新会话默认使用这个实例；名字跟随 agent，不能重命名或删除。"),
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: "删除实例" })).toBeNull()

    await userEvent.click(screen.getByRole("button", { name: "添加实例" }))
    // 第一步预选当前 agent，直接下一步。
    expect(screen.getByRole("option", { name: /Claude Code/ }).getAttribute("aria-selected")).toBe(
      "true",
    )
    await userEvent.click(screen.getByRole("button", { name: "下一步" }))
    await userEvent.type(screen.getByRole("textbox", { name: "实例名称" }), "公司 API")
    await userEvent.click(screen.getByRole("button", { name: "下一步" }))
    await userEvent.click(screen.getByRole("button", { name: "创建实例" }))
    await waitFor(() =>
      expect(props.onCreateInstance).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "claude" }),
        "公司 API",
        null,
      ),
    )
  })

  it("lists every instance in the list and renames, disables, defaults and removes one", async () => {
    const props = renderPage({
      agents: [
        agent({
          instances: [
            {
              instanceId: "claude",
              agentId: "claude",
              label: "Claude Code",
              enabled: true,
              values: {},
              isDefault: true,
              createdAt: null,
            },
            {
              instanceId: "inst_work",
              agentId: "claude",
              label: "公司 API",
              enabled: true,
              values: {},
              isDefault: false,
              createdAt: "2026-11-01T00:00:00.000Z",
            },
          ],
        }),
      ],
    })
    // 左栏两行：默认实例与新实例。
    expect(screen.getByRole("button", { name: "打开 公司 API 的设置" })).toBeTruthy()
    await openInstance("公司 API")

    const name = screen.getByRole("textbox", { name: "实例名称" })
    await userEvent.clear(name)
    await userEvent.type(name, "个人号")
    await userEvent.click(screen.getByRole("button", { name: "改名称" }))
    await waitFor(() =>
      expect(props.onUpdateInstance).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "claude" }),
        "inst_work",
        { label: "个人号" },
      ),
    )

    await userEvent.click(screen.getByRole("switch", { name: "启用这个实例" }))
    await waitFor(() =>
      expect(props.onUpdateInstance).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "claude" }),
        "inst_work",
        { enabled: false },
      ),
    )

    await userEvent.click(screen.getByRole("button", { name: "设为新会话默认" }))
    await waitFor(() => expect(props.onSetDefault).toHaveBeenCalledWith("inst_work"))

    await userEvent.click(screen.getByRole("button", { name: "删除实例" }))
    await userEvent.click(screen.getByRole("button", { name: "确认删除" }))
    await waitFor(() =>
      expect(props.onRemoveInstance).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "claude" }),
        "inst_work",
      ),
    )
  })

  it("keeps each instance's own values while switching between them", async () => {
    const props = renderPage({
      agents: [
        agent({
          instances: [
            {
              instanceId: "claude",
              agentId: "claude",
              label: "Claude Code",
              enabled: true,
              values: { launchArgs: "--default" },
              isDefault: true,
              createdAt: null,
            },
            {
              instanceId: "inst_work",
              agentId: "claude",
              label: "公司 API",
              enabled: true,
              values: { launchArgs: "--work" },
              isDefault: false,
              createdAt: "2026-11-01T00:00:00.000Z",
            },
          ],
        }),
      ],
    })
    const args = () => screen.getByRole("textbox", { name: "启动参数" }) as HTMLInputElement
    expect(args().value).toBe("--default")

    await openInstance("公司 API")
    expect(args().value).toBe("--work")
    await userEvent.type(args(), " extra")
    await userEvent.click(screen.getByRole("button", { name: "保存" }))
    await waitFor(() =>
      expect(props.onSaveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "claude" }),
        expect.objectContaining({ instanceId: "inst_work" }),
        { launchArgs: "--work extra" },
      ),
    )
  })
})

describe("agent status helpers", () => {
  it("orders disabled, failed, checking, missing, signed out and ready", () => {
    const base = { enabled: true, registered: true, error: null }
    expect(agentHeadline({ ...base, enabled: false }, READY).label).toBe("agents.status.disabled")
    expect(agentHeadline({ ...base, registered: false, error: "boom" }, READY)).toMatchObject({
      tone: "error",
      detail: "boom",
    })
    expect(agentHeadline(base, undefined).tone).toBe("checking")
    expect(
      agentHeadline(base, { installed: false, version: null, authenticated: null }).label,
    ).toBe("agents.status.notInstalled")
    expect(agentHeadline(base, { ...READY, authenticated: false }).tone).toBe("warning")
    expect(agentHeadline(base, { installed: true, version: null, authenticated: null }).tone).toBe(
      "ready",
    )
    // 实例自己停用时先说停用。
    expect(instanceHeadline(base, { enabled: false }, READY).label).toBe("agents.status.disabled")
    expect(instanceHeadline(base, { enabled: true }, READY).tone).toBe("ready")
    expect(entityMark("claude", "Claude Code").initials).toBe("CC")
    expect(entityMark("codex", "codex").initials).toBe("CO")
  })
})
