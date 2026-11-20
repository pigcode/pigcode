/** 验证 Agent 设置页：左边列表、右边选中那一个的设置、状态与账号、启用开关、启动设置、环境变量与模型（显示、排序、自定义）的保存。 */
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

const TWO_CLAUDES: AgentSummary["instances"] = [
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
]

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
  const page = (next: Partial<AgentsPageProps> = {}) => (
    <LocaleProvider locale="zh-CN">
      <AgentsPage {...props} {...next} />
    </LocaleProvider>
  )
  const { rerender } = render(page())
  return { ...props, rerenderPage: (next: Partial<AgentsPageProps>) => rerender(page(next)) }
}

/** 选中一个 Agent：列表里的一行是一整块按钮，右边换成它的设置。 */
const instanceButton = (label: string) =>
  screen.getByRole("button", { name: `打开 ${label} 的设置` })
const openInstance = (label: string) => userEvent.click(instanceButton(label))

/** 列表里的一行：选中按钮铺在这一行下面，文字、开关和图标在它旁边。 */
const cardHead = (label: string) =>
  screen.getByRole("button", { name: `打开 ${label} 的设置` }).closest(".agent-item") as HTMLElement

describe("AgentsPage", () => {
  it("lists every agent with its brand icon, version and status, and shows the account on the right", async () => {
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
    // 一行是名字、版本和状态；能用时跟着套餐，echo 还在检查。
    expect(claude.textContent).toContain("能用 · max · claude.ai")
    expect(claude.textContent).toContain("2.1.304")
    expect(echo.textContent).toContain("检查中…")
    expect(screen.queryByText("内置")).toBeNull()

    // 打开时选中第一个，右边是它的设置。
    const detail = screen.getByRole("region", { name: "Claude Code" })
    expect(detail.textContent).toContain("max · claude.ai")
    // 邮箱默认遮住（同长的打乱字符），点一下显示、再点隐藏。
    expect(detail.textContent).not.toContain("dev@example.com")
    await userEvent.click(within(detail).getByRole("button", { name: "点击显示账号" }))
    expect(detail.textContent).toContain("dev@example.com")
    await userEvent.click(within(detail).getByRole("button", { name: "点击隐藏账号" }))
    expect(detail.textContent).not.toContain("dev@example.com")
  })

  it("selects the first agent, switches on click and loads the selected agent's models", async () => {
    const onLoadModels = vi.fn()
    renderPage({ onLoadModels })
    expect(instanceButton("Claude Code").getAttribute("aria-current")).toBe("true")
    expect(screen.getByRole("region", { name: "Claude Code" })).toBeTruthy()
    expect(onLoadModels).toHaveBeenCalledWith("claude")
    expect(onLoadModels).not.toHaveBeenCalledWith("echo")
    // 启动设置直接排在右边。
    expect(screen.getByRole("textbox", { name: "启动参数" })).toBeTruthy()

    await openInstance("Echo")
    expect(instanceButton("Claude Code").getAttribute("aria-current")).toBeNull()
    expect(instanceButton("Echo").getAttribute("aria-current")).toBe("true")
    expect(screen.getByRole("region", { name: "Echo" })).toBeTruthy()
    expect(screen.queryByRole("textbox", { name: "启动参数" })).toBeNull()
    expect(onLoadModels).toHaveBeenCalledWith("echo")

    // 再点一次还是选中它。
    await openInstance("Echo")
    expect(instanceButton("Echo").getAttribute("aria-current")).toBe("true")
  })

  it("toggles a plugin-backed agent from its row", async () => {
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
    // 状态里是账号和套餐，版本在名字右边，程序位置在「其他」里。
    expect(screen.queryByText("dev@example.com")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "点击显示账号" }))
    expect(screen.getByText("dev@example.com")).toBeTruthy()
    expect(screen.getAllByText("2.1.304").length).toBeGreaterThan(0)
    // 模型列出目录里的模型，标出默认模型。
    const list = screen.getByRole("list", { name: "模型" })
    expect(list.textContent).toContain("Default (recommended)")
    expect(list.textContent).toContain("Opus 5.5")
    expect(screen.getByText("显示 2/2")).toBeTruthy()

    expect(screen.getByText("/usr/local/bin/claude")).toBeTruthy()
    fireEvent.change(screen.getByRole("textbox", { name: "可执行文件" }), {
      target: { value: "/opt/claude" },
    })
    fireEvent.change(screen.getByRole("textbox", { name: "启动参数" }), {
      target: { value: "--chrome" },
    })
    await userEvent.click(screen.getByRole("button", { name: "添加变量" }))
    fireEvent.change(screen.getByRole("textbox", { name: "变量名 1" }), {
      target: { value: "HTTPS_PROXY" },
    })
    fireEvent.change(screen.getByLabelText("值 1"), {
      target: { value: "http://127.0.0.1:7890" },
    })
    // 没填名字的行保存时去掉。
    await userEvent.click(screen.getByRole("button", { name: "添加变量" }))
    const model = screen.getByRole("textbox", { name: "输入模型 ID，回车添加" })
    await userEvent.type(model, "opus{Enter}")
    expect(screen.getByText("已经有这个模型了")).toBeTruthy()
    await userEvent.clear(model)
    await userEvent.type(model, "claude-sonnet-5{Enter}")
    await userEvent.type(model, "claude-sonnet-5{Enter}")
    expect(screen.getByText("已经加过了")).toBeTruthy()
    expect(screen.getByText("显示 3/3")).toBeTruthy()

    expect(screen.getByText("还没保存")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "保存" }))
    await waitFor(() => expect(props.onSaveSettings).toHaveBeenCalledTimes(1))
    const savedValues = {
      binaryPath: "/opt/claude",
      launchArgs: "--chrome",
      environment: [
        { name: "HTTPS_PROXY", value: { secret: "http://127.0.0.1:7890" }, sensitive: true },
      ],
      customModels: ["claude-sonnet-5"],
    }
    expect(props.onSaveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "claude" }),
      expect.objectContaining({ instanceId: "claude" }),
      savedValues,
    )
    const notice = "已保存"
    expect(await screen.findByText(notice)).toBeTruthy()
    props.rerenderPage({ agents: [agent({ values: savedValues })] })
    expect(screen.getByText(notice)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "保存" }).disabled).toBe(true)
  })

  it("explains a signed-out agent in its status", async () => {
    renderPage({ statuses: { claude: { ...READY, authenticated: false, email: null } } })
    const claude = cardHead("Claude Code")
    expect(claude.textContent).toContain("没登录")
    expect(claude.textContent).not.toContain("max · claude.ai")
    const detail = screen.getByRole("region", { name: "Claude Code" })
    expect(within(detail).getByText(/在终端登录/)).toBeTruthy()
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

  it("keeps third-party agent settings available without an uninstall action", async () => {
    renderPage()
    await openInstance("Echo")
    const detail = screen.getByRole("region", { name: "Echo" })
    expect(within(detail).getByRole("button", { name: "还原" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "卸载" })).toBeNull()
  })

  it("shows the CLI install hint when an agent plugin is enabled but the CLI is missing", async () => {
    renderPage({ statuses: { claude: { installed: false, version: null, authenticated: null } } })
    expect(cardHead("Claude Code").textContent).toContain("没安装")
    const detail = screen.getByRole("region", { name: "Claude Code" })
    expect(within(detail).getByText("安装 Claude Code")).toBeTruthy()
    expect(within(detail).getByRole("textbox", { name: "可执行文件" })).toBeTruthy()
  })

  it("sets the agent new sessions start with, including back to automatic", async () => {
    const props = renderPage({
      agents: [agent({ instances: TWO_CLAUDES })],
      defaultInstanceId: "inst_work",
    })
    // 选择器显示实际生效的那个，打开时右边选中的也是它。
    expect(screen.getByRole("combobox", { name: "默认用" }).textContent).toContain("公司 API")
    expect(instanceButton("公司 API").getAttribute("aria-current")).toBe("true")

    await userEvent.click(screen.getByRole("combobox", { name: "默认用" }))
    await userEvent.click(await screen.findByRole("option", { name: "自动" }, { timeout: 3_000 }))
    await waitFor(() => expect(props.onSetDefault).toHaveBeenCalledWith(null))
  })

  it("directs users to the Plugins page when there are no agents to configure", async () => {
    renderPage({ agents: [] })
    expect(screen.getByText("还没有 Agent")).toBeTruthy()
    expect(screen.getByText("先去「插件」页打开一个 Agent")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "添加 Agent" })).toBeNull()
  })

  it("creates a configured agent from the searchable directory", async () => {
    const props = renderPage()
    // 内置的那一个不能改名字，也不能删除。
    expect(screen.queryByRole("textbox", { name: "名字" })).toBeNull()
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull()

    await userEvent.click(screen.getByRole("button", { name: "添加 Agent" }))
    expect(screen.getByRole("option", { name: /Claude Code/ }).getAttribute("aria-selected")).toBe(
      "true",
    )
    await userEvent.click(screen.getByRole("option", { name: "Claude Code" }))
    await userEvent.type(screen.getByRole("textbox", { name: "名字" }), "公司 API")
    const id = screen.getByRole("textbox", { name: "ID" })
    expect(id).toHaveProperty("value", "claude_api")
    await userEvent.clear(id)
    await userEvent.type(id, "claude")
    expect(id.getAttribute("aria-invalid")).toBe("true")
    await userEvent.clear(id)
    await userEvent.type(id, "work-api")
    const wizard = within(screen.getByRole("dialog", { name: "添加 Agent" }))
    expect(wizard.queryByRole("button", { name: "添加变量" })).toBeNull()
    expect(wizard.queryByRole("textbox", { name: "输入模型 ID，回车添加" })).toBeNull()
    // 启动设置也收在「高级设置」里。
    expect(wizard.queryByRole("textbox", { name: "启动参数" })).toBeNull()
    await userEvent.click(wizard.getByRole("button", { name: "高级设置" }))
    await userEvent.type(wizard.getByRole("textbox", { name: "启动参数" }), "--chrome")
    await userEvent.click(screen.getByRole("button", { name: "创建" }))
    await waitFor(() =>
      expect(props.onCreateInstance).toHaveBeenCalledWith({
        agentId: "claude",
        instanceId: "work-api",
        label: "公司 API",
        values: { launchArgs: "--chrome" },
      }),
    )
  })

  it("renames, recolors, disables, sets as default and deletes an agent the user added", async () => {
    const props = renderPage({ agents: [agent({ instances: TWO_CLAUDES })] })
    await openInstance("公司 API")
    expect(
      within(screen.getByRole("region", { name: "公司 API" })).getByText("inst_work"),
    ).toBeTruthy()

    const name = screen.getByRole("textbox", { name: "名字" })
    await userEvent.clear(name)
    await userEvent.type(name, "个人号")
    // 名字和颜色进同一份草稿，由底部浮出的保存条一起保存；颜色在名字旁边的色板里。
    await userEvent.click(screen.getByRole("button", { name: "颜色" }))
    await userEvent.click(await screen.findByRole("button", { name: "#3b9a6d" }))
    await userEvent.click(screen.getByRole("button", { name: "保存" }))
    await waitFor(() =>
      expect(props.onUpdateInstance).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "claude" }),
        "inst_work",
        { label: "个人号", accentColor: "#3b9a6d" },
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

    await userEvent.click(screen.getByRole("combobox", { name: "默认用" }))
    await userEvent.click(
      await screen.findByRole("option", { name: "公司 API" }, { timeout: 3_000 }),
    )
    await waitFor(() => expect(props.onSetDefault).toHaveBeenCalledWith("inst_work"))

    await userEvent.click(screen.getByRole("button", { name: "删除" }))
    await userEvent.click(screen.getByRole("button", { name: "确定删除" }))
    await waitFor(() =>
      expect(props.onRemoveInstance).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "claude" }),
        "inst_work",
      ),
    )
  })

  it("keeps each agent's own values while switching between them", async () => {
    const props = renderPage({
      agents: [
        agent({
          instances: [
            { ...TWO_CLAUDES[0]!, values: { launchArgs: "--default" } },
            { ...TWO_CLAUDES[1]!, values: { launchArgs: "--work" } },
          ],
        }),
      ],
    })
    const args = () => screen.getByRole("textbox", { name: "启动参数" }) as HTMLInputElement
    expect(args().value).toBe("--default")

    await openInstance("公司 API")
    expect(args().value).toBe("--work")
    await userEvent.type(args(), " extra")
    props.rerenderPage({ agents: structuredClone(props.agents) })
    expect(args().value).toBe("--work extra")
    await openInstance("Claude Code")
    expect(args().value).toBe("--default")
    await openInstance("公司 API")
    expect(args().value).toBe("--work extra")
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
