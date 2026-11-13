/** 验证 Agent 设置页：实例卡片、就地展开、账号与状态、启用开关、标签页里的表单、环境变量与模型（显示、排序、自定义）的保存。 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AgentSummary, AgentStatus } from "@pigcode/contracts"
import { LocaleProvider, entityMark } from "@pigcode/ui-primitives"
import { AgentsPage, type AgentsPageProps } from "./agents-page"

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
  email: "dev@example.com",
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
    ...overrides,
  }
  render(
    <LocaleProvider locale="zh-CN">
      <AgentsPage {...props} />
    </LocaleProvider>,
  )
  return props
}

/** 展开一个实例：卡片头是一整块按钮。 */
const openInstance = (label: string) =>
  userEvent.click(screen.getByRole("button", { name: `打开 ${label} 的设置` }))

/** 实例卡片头：展开按钮铺在这一块下面，文字与图标在它旁边。 */
const cardHead = (label: string) =>
  screen.getByRole("button", { name: `打开 ${label} 的设置` }).closest(".agent-row") as HTMLElement

/** 切到展开区里的一个标签页。 */
const openTab = (name: string) =>
  userEvent.click(screen.getByRole("tab", { name: new RegExp(`^${name}`) }))

describe("AgentsPage", () => {
  it("lists every instance with its brand icon, status and signed-in account", async () => {
    renderPage()
    // 两个 agent 的默认实例各占一行，默认实例用 agent 的名字。
    const claude = cardHead("Claude Code")
    const echo = cardHead("Echo")
    // 认得出的 driver 画品牌标志，第三方 agent 画名字缩写。
    expect(claude.querySelector(".agent-brand")?.getAttribute("data-brand")).toBe("claude")
    expect(echo.querySelector(".agent-brand")).toBeNull()
    expect(echo.querySelector(".entity-avatar")?.textContent).toBe(
      entityMark("echo", "Echo").initials,
    )
    // 卡片头是状态、登录的邮箱与订阅；版本放在展开后的概览里。echo 还在检测中。
    expect(claude.textContent).toContain("就绪")
    expect(claude.textContent).toContain("max · claude.ai")
    expect(claude.textContent).not.toContain("2.1.304")
    expect(echo.textContent).toContain("检测中…")
    expect(screen.queryByText("内置")).toBeNull()

    // 邮箱默认遮住（同长的打乱字符），点一下显示，不会顺带展开卡片。
    expect(claude.textContent).not.toContain("dev@example.com")
    await userEvent.click(within(claude).getByRole("button", { name: "点击显示账号" }))
    expect(claude.textContent).toContain("dev@example.com")
    expect(
      screen.getByRole("button", { name: "打开 Claude Code 的设置" }).getAttribute("aria-expanded"),
    ).toBe("false")
    await userEvent.click(within(claude).getByRole("button", { name: "点击隐藏账号" }))
    expect(claude.textContent).not.toContain("dev@example.com")
  })

  it("starts collapsed and expands one instance at a time, loading its models", async () => {
    const onLoadModels = vi.fn()
    renderPage({ onLoadModels })
    expect(screen.queryByRole("textbox", { name: "启动参数" })).toBeNull()

    await openInstance("Claude Code")
    expect(
      screen.getByRole("button", { name: "打开 Claude Code 的设置" }).getAttribute("aria-expanded"),
    ).toBe("true")
    // 先看到模型页；运行设置在「运行」标签里。
    expect(screen.getByRole("tab", { name: /^模型/ }).getAttribute("aria-selected")).toBe("true")
    await openTab("运行")
    expect(screen.getByRole("textbox", { name: "启动参数" })).toBeTruthy()
    expect(onLoadModels).toHaveBeenCalledWith("claude")

    // 展开另一个时，前一个收起。Echo 没有声明字段。
    await openInstance("Echo")
    expect(
      screen.getByRole("button", { name: "打开 Claude Code 的设置" }).getAttribute("aria-expanded"),
    ).toBe("false")
    expect(screen.queryByRole("textbox", { name: "启动参数" })).toBeNull()
    expect(onLoadModels).toHaveBeenCalledWith("echo")

    // 再点一次收起。
    await openInstance("Echo")
    expect(
      screen.getByRole("button", { name: "打开 Echo 的设置" }).getAttribute("aria-expanded"),
    ).toBe("false")
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
    const props = renderPage({
      models: {
        claude: [
          { id: "default", label: "Default (recommended)", isDefault: true },
          { id: "opus", label: "Opus 5.5" },
        ],
      },
    })
    await openInstance("Claude Code")
    // 概览里是登录的账号、订阅、版本与可执行文件。
    expect(screen.getByText("/usr/local/bin/claude")).toBeTruthy()
    // 卡片头与概览共用一个显示开关。
    expect(screen.queryByText("dev@example.com")).toBeNull()
    await userEvent.click(screen.getAllByRole("button", { name: "点击显示账号" })[1]!)
    expect(screen.getAllByText("dev@example.com")).toHaveLength(2)
    expect(screen.getByText("2.1.304")).toBeTruthy()
    // 模型页列出目录里的模型，标出默认模型。
    const list = screen.getByRole("list", { name: "模型" })
    expect(list.textContent).toContain("Default (recommended)")
    expect(list.textContent).toContain("Opus 5.5")
    expect(screen.getByText("2 个模型，2 个显示在选择器里")).toBeTruthy()

    // 改动跨标签页保留，最后一起保存。
    await openTab("运行")
    await userEvent.type(screen.getByRole("textbox", { name: "可执行文件" }), "/opt/claude")
    await userEvent.type(screen.getByRole("textbox", { name: "启动参数" }), "--chrome")
    await openTab("环境变量")
    await userEvent.click(screen.getByRole("button", { name: "添加变量" }))
    await userEvent.type(screen.getByRole("textbox", { name: "变量名 1" }), "HTTPS_PROXY")
    await userEvent.type(screen.getByRole("textbox", { name: "值 1" }), "http://127.0.0.1:7890")
    // 没填名字的行保存时去掉。
    await userEvent.click(screen.getByRole("button", { name: "添加变量" }))
    await openTab("模型")
    const model = screen.getByRole("textbox", { name: "模型 id，回车添加" })
    await userEvent.type(model, "opus{Enter}")
    expect(screen.getByText("目录里已经有这个模型")).toBeTruthy()
    await userEvent.clear(model)
    await userEvent.type(model, "claude-sonnet-5{Enter}")
    await userEvent.type(model, "claude-sonnet-5{Enter}")
    expect(screen.getByText("已经添加过这个模型")).toBeTruthy()
    expect(screen.getByText("3 个模型，3 个显示在选择器里")).toBeTruthy()

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

  it("explains a signed-out instance in the overview", async () => {
    renderPage({ statuses: { claude: { ...READY, authenticated: false, email: null } } })
    const claude = cardHead("Claude Code")
    expect(claude.textContent).toContain("未登录")
    expect(claude.textContent).not.toContain("max · claude.ai")
    await openInstance("Claude Code")
    expect(screen.getByRole("note").textContent).toContain("在终端里用这个 CLI 登录")
  })

  it("shows the save error and keeps the draft", async () => {
    renderPage({
      onSaveSettings: vi.fn(async () => {
        throw new Error("invalid value for claude.binaryPath")
      }),
    })
    await openInstance("Claude Code")
    await openTab("运行")
    fireEvent.change(screen.getByRole("textbox", { name: "启动参数" }), {
      target: { value: "--x" },
    })
    await userEvent.click(screen.getByRole("button", { name: "保存" }))
    expect(await screen.findByText(/invalid value for claude\.binaryPath/)).toBeTruthy()
    expect((screen.getByRole("textbox", { name: "启动参数" }) as HTMLInputElement).value).toBe(
      "--x",
    )
  })

  it("keeps third-party agent settings available without an uninstall action", async () => {
    renderPage()
    await openInstance("Echo")
    expect(screen.getByRole("button", { name: "设为新会话默认" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "卸载" })).toBeNull()
  })

  it("shows the CLI install hint when an agent plugin is enabled but the CLI is missing", async () => {
    renderPage({ statuses: { claude: { installed: false, version: null, authenticated: null } } })
    expect(cardHead("Claude Code").textContent).toContain("未安装")
    await openInstance("Claude Code")
    expect(within(screen.getByRole("note")).getByText("安装 Claude Code")).toBeTruthy()
    await openTab("运行")
    expect(screen.getByRole("textbox", { name: "可执行文件" })).toBeTruthy()
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
    // 弹出层是异步挂上的，机器忙的时候点开后不会马上出现（CI 的 macOS 上偶发失败过）。
    await userEvent.click(await screen.findByRole("option", { name: "自动" }, { timeout: 3_000 }))
    await waitFor(() => expect(props.onSetDefault).toHaveBeenCalledWith(null))
  })

  it("directs users to the Plugins page when there are no agents to configure", async () => {
    renderPage({ agents: [] })
    expect(screen.getByText("还没有 agent")).toBeTruthy()
    expect(screen.getByText("在侧栏的「插件」页安装 agent 插件。")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "添加实例" }))
    expect(screen.getByText("请启用已有的 agent，或在「插件」页安装 agent 插件。")).toBeTruthy()
  })

  it("creates another instance through the three-step wizard", async () => {
    const props = renderPage()
    // 默认实例不能改名或删除，只能设为新会话默认。
    await openInstance("Claude Code")
    expect(screen.queryByRole("textbox", { name: "实例名称" })).toBeNull()
    expect(screen.queryByRole("button", { name: "删除实例" })).toBeNull()
    expect(screen.getByRole("button", { name: "设为新会话默认" })).toBeTruthy()

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
    // 两行：默认实例与新实例；新实例的行里带它的 id。
    expect(cardHead("公司 API").textContent).toContain("inst_work")
    await openInstance("公司 API")
    await openTab("实例")

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

    await userEvent.click(screen.getByRole("switch", { name: "启用 公司 API" }))
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
    await openInstance("Claude Code")
    await openTab("运行")
    expect(args().value).toBe("--default")

    await openInstance("公司 API")
    await openTab("运行")
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
