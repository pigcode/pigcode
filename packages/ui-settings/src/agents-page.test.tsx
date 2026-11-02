/** 验证 Agent 设置页：状态、启用开关、按 manifest 生成的表单、环境变量与自定义模型的保存。 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AgentSummary, ProviderStatus } from "@pigcode/contracts"
import { LocaleProvider, entityMark } from "@pigcode/ui-primitives"
import { AgentsPage, type AgentsPageProps } from "./agents-page"
import { agentHeadline } from "./agent-status"

afterEach(cleanup)

const CAPABILITIES = {
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
    providerId: "claude",
    displayName: "Claude Code",
    pluginId: "agent.@pigcode/agent-claude",
    version: "0.1.0",
    builtin: true,
    enabled: true,
    registered: true,
    capabilities: CAPABILITIES,
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
    ...overrides,
  }
}

const READY: ProviderStatus = {
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
        providerId: "echo",
        displayName: "Echo",
        pluginId: "agent.pigcode-provider-echo",
        builtin: false,
        fields: [],
        description: null,
        homepage: null,
        installHint: null,
      }),
    ],
    defaultProviderId: null,
    statuses: { claude: READY },
    onDetect: vi.fn(async () => undefined),
    onSetEnabled: vi.fn(async () => undefined),
    onSaveSettings: vi.fn(async () => undefined),
    onSetDefault: vi.fn(async () => undefined),
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

describe("AgentsPage", () => {
  it("lists agents with their status and built-in badge", () => {
    renderPage()
    expect(screen.getByText("Claude Code")).toBeTruthy()
    expect(screen.getByText("内置")).toBeTruthy()
    expect(screen.getByText("就绪")).toBeTruthy()
    expect(screen.getByText(/2\.1\.304 · max · claude\.ai/)).toBeTruthy()
    // echo 还没有检测结果。
    expect(screen.getByText("检测中…")).toBeTruthy()
  })

  it("shows the default agent, or Automatic when it is disabled or gone", () => {
    const selector = () => screen.getByRole("combobox", { name: "新会话使用" })
    renderPage({ defaultProviderId: "echo" })
    expect(selector().textContent).toContain("Echo")
    cleanup()

    const claude = agent({})
    const echo = agent({ providerId: "echo", displayName: "Echo", enabled: false })
    renderPage({ agents: [claude, echo], defaultProviderId: "echo" })
    expect(selector().textContent).toContain("自动")
    cleanup()

    renderPage({ defaultProviderId: "removed-agent" })
    expect(selector().textContent).toContain("自动")
    expect(selector().textContent).not.toContain("removed-agent")
  })

  it("toggles an agent through its plugin", async () => {
    const props = renderPage()
    await userEvent.click(screen.getByRole("switch", { name: "启用 Echo" }))
    await waitFor(() =>
      expect(props.onSetEnabled).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: "echo" }),
        false,
      ),
    )
  })

  it("edits manifest fields, environment and custom models, then saves", async () => {
    const props = renderPage()
    await userEvent.click(screen.getByRole("button", { name: "展开 Claude Code 的设置" }))
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
      expect.objectContaining({ providerId: "claude" }),
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
    await userEvent.click(screen.getByRole("button", { name: "展开 Claude Code 的设置" }))
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
    await userEvent.click(screen.getByRole("button", { name: "展开 Claude Code 的设置" }))
    expect(screen.queryByRole("button", { name: "卸载" })).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "展开 Echo 的设置" }))
    await userEvent.click(screen.getByRole("button", { name: "卸载" }))
    await userEvent.click(screen.getByRole("button", { name: "确认卸载" }))
    await waitFor(() =>
      expect(props.onUninstall).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: "echo" }),
      ),
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
    expect(entityMark("claude", "Claude Code").initials).toBe("CC")
    expect(entityMark("codex", "codex").initials).toBe("CO")
  })
})
