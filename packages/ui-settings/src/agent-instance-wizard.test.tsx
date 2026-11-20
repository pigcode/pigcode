// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import type {
  AcpRegistryEntry,
  AgentAuthState,
  AgentInstance,
  AgentInstanceDraft,
  AgentSummary,
} from "@pigcode/contracts"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { AgentsPage } from "./agents-page"

afterEach(cleanup)

const acp: AgentSummary = {
  agentId: "acp",
  displayName: "ACP",
  pluginId: "agent.@pigcode/agent-acp",
  version: "0.99.7",
  builtin: true,
  enabled: true,
  registered: true,
  features: null,
  acpRegistry: true,
  description: null,
  homepage: null,
  installHint: null,
  customModels: false,
  values: {},
  error: null,
  instances: [],
  fields: [
    { key: "binaryPath", type: "path", pathKind: "file", label: "可执行文件" },
    { key: "arguments", type: "arguments", label: "启动参数" },
    { key: "registryId", type: "text", label: "ACP Registry ID" },
    { key: "authMethodId", type: "text", label: "认证方式 ID" },
  ],
}

const item: AcpRegistryEntry = {
  id: "amp-acp",
  name: "Amp",
  version: "0.13.0",
  description: "Amp ACP adapter",
  distribution: "binary",
  website: "https://example.org/amp",
}
const noop = async () => undefined
const account: AgentAuthState = {
  phase: "signed-out",
  flowId: null,
  error: null,
  authorizationUrl: null,
  expiresAt: null,
  methods: [{ id: "terminal", name: "Terminal" }],
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function openWizard(
  options: {
    prepare?: (id: string) => Promise<AcpRegistryEntry>
    extras?: AgentSummary[]
    create?: (draft: AgentInstanceDraft) => Promise<string>
    instances?: AgentInstance[]
  } = {},
) {
  const prepare = vi.fn(options.prepare ?? (async () => item))
  const create = vi.fn(options.create ?? (async (draft: AgentInstanceDraft) => draft.instanceId))
  const auth = vi.fn(async () => account)
  const openExternal = vi.fn(noop)
  const dedicated = {
    ...acp,
    acpRegistry: false,
    agentId: "claude",
    displayName: "Claude Code",
    featured: true,
  }
  const secondary = { ...dedicated, agentId: "other", displayName: "Other", featured: false }
  render(
    <LocaleProvider locale="zh-CN">
      <AgentsPage
        agents={[
          dedicated,
          secondary,
          ...(options.extras ?? []),
          { ...acp, instances: options.instances ?? [] },
        ]}
        defaultAgentId={null}
        statuses={{}}
        onDetect={noop}
        onSetEnabled={noop}
        onSaveSettings={noop}
        onSetDefault={noop}
        onUpdateInstance={noop}
        onRemoveInstance={noop}
        onCreateInstance={create}
        onOpenExternal={openExternal}
        setupActions={{ auth, accountChanged: vi.fn(), cancelInstall: noop, removeInstall: noop }}
        registry={{ list: async () => [item], prepare }}
      />
    </LocaleProvider>,
  )
  await userEvent.click(screen.getByRole("button", { name: "添加实例" }))
  const wizard = within(screen.getByRole("dialog"))
  expect(wizard.getByRole("option", { name: "Claude Code" })).toBeTruthy()
  expect(wizard.queryByRole("option", { name: "Other" })).toBeNull()
  expect(wizard.queryByText("0.99.7")).toBeNull()
  await userEvent.click(wizard.getByRole("button", { name: "更多 Agent" }))
  expect(wizard.getByRole("option", { name: "Other" })).toBeTruthy()
  return { wizard, prepare, create, auth, openExternal }
}
const button = (name: string) => screen.getByRole("button", { name })
const field = (name: string) => screen.getByRole("textbox", { name })

it("prepares from the row before identity, saves once, and offers account setup after the save", async () => {
  const installing = deferred<AcpRegistryEntry>()
  const saving = deferred<string>()
  const { prepare, create, auth, openExternal, wizard } = await openWizard({
    prepare: () => installing.promise,
    create: () => saving.promise,
  })
  await userEvent.click(await wizard.findByRole("button", { name: "了解 Amp" }))
  expect(openExternal).toHaveBeenCalledWith(item.website)
  expect(prepare).not.toHaveBeenCalled()
  expect(wizard.queryByText(item.version)).toBeNull()
  await userEvent.click(button("添加 Amp"))
  expect(prepare).toHaveBeenCalledExactlyOnceWith(item.id)
  expect(button("下载中… Amp")).toHaveProperty("disabled", true)
  expect(create).not.toHaveBeenCalled()
  installing.resolve(item)
  expect(await wizard.findByRole("textbox", { name: "实例名称" })).toHaveProperty("value", "Amp")
  expect(wizard.getByText("0.13.0 · binary")).toBeTruthy()
  await userEvent.click(button("继续登录"))
  expect(create).toHaveBeenCalledExactlyOnceWith({
    agentId: "acp",
    label: "Amp",
    preparedVersion: item.version,
    instanceId: "acp_amp",
    values: { registryId: "amp-acp" },
  })
  expect(auth).not.toHaveBeenCalled()
  saving.resolve("acp_amp")
  await wizard.findByRole("button", { name: "登录 · Terminal" })
  expect(auth).toHaveBeenCalledWith("acp_amp", { action: "status", refresh: true })
  await userEvent.click(button("稍后登录"))
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("retries a failed preparation in place and can leave the prepared draft without creating an instance", async () => {
  const attempt = vi
    .fn<(id: string) => Promise<AcpRegistryEntry>>()
    .mockRejectedValueOnce(new Error("Download failed"))
    .mockResolvedValue(item)
  const { wizard, create } = await openWizard({ prepare: attempt })
  await userEvent.click(await wizard.findByRole("button", { name: "添加 Amp" }))
  expect((await wizard.findByRole("alert")).textContent).toContain("Download failed")
  await userEvent.click(button("重试 Amp"))
  await wizard.findByRole("textbox", { name: "实例名称" })
  await userEvent.click(wizard.getByRole("button", { name: "关闭" }))
  expect(attempt).toHaveBeenCalledTimes(2)
  expect(create).not.toHaveBeenCalled()
})

it("uses the manual registry ID and executable override for a second configuration", async () => {
  const instances: AgentInstance[] = [
    {
      agentId: "acp",
      instanceId: "acp_amp",
      label: "Amp",
      isDefault: false,
      enabled: true,
      createdAt: null,
      values: { registryId: item.id },
    },
  ]
  const { wizard, prepare, create } = await openWizard({ instances })
  expect(await wizard.findByRole("button", { name: "已添加 Amp" })).toHaveProperty("disabled", true)
  await userEvent.click(button("手动填写"))
  await userEvent.type(field("ACP Registry ID"), item.id)
  await userEvent.type(field("可执行文件"), "my-amp-acp")
  await userEvent.type(field("认证方式 ID"), "terminal")
  await userEvent.click(button("下一步"))
  await userEvent.clear(field("实例名称"))
  await userEvent.type(field("实例名称"), "Amp")
  expect(field("实例 ID")).not.toHaveProperty("value", "acp_amp")
  await userEvent.click(button("继续登录"))
  expect(prepare).not.toHaveBeenCalled()
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      label: "Amp",
      values: { registryId: item.id, binaryPath: "my-amp-acp", authMethodId: "terminal" },
    }),
  )
})

it("takes the literal local command before identity and finishes without an install or login step", async () => {
  const { wizard, prepare, create, auth } = await openWizard()
  await userEvent.click(button("本地 ACP 命令"))
  expect(button("下一步")).toHaveProperty("disabled", true)
  await userEvent.type(field("可执行文件"), "/path/to/acp command")
  await userEvent.click(button("添加参数"))
  fireEvent.change(field("参数 1"), { target: { value: "acp" } })
  await userEvent.click(button("添加参数"))
  fireEvent.change(field("参数 2"), { target: { value: "with spaces" } })
  await userEvent.click(button("下一步"))
  await userEvent.type(wizard.getByRole("textbox", { name: "实例名称" }), "Local")
  await userEvent.click(button("创建实例"))
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      label: "Local",
      values: { binaryPath: "/path/to/acp command", arguments: ["acp", "with spaces"] },
    }),
  )
  expect(prepare).not.toHaveBeenCalled()
  expect(auth).not.toHaveBeenCalled()
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("saves an optional accent and uses a recognizable default label for an unnamed instance", async () => {
  const { wizard, create } = await openWizard()
  await userEvent.click(wizard.getByRole("option", { name: "Claude Code" }))
  await userEvent.click(wizard.getByRole("button", { name: "下一步" }))
  fireEvent.change(wizard.getByLabelText("实例强调色"), { target: { value: "#a0522d" } })
  await userEvent.click(wizard.getByRole("button", { name: "下一步" }))
  await userEvent.click(wizard.getByRole("button", { name: "创建实例" }))
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ label: "Claude Code", accentColor: "#a0522d" }),
  )
})
it("creates a named, private Codex account from the ChatGPT branch before starting sign-in", async () => {
  const codex: AgentSummary = {
    ...acp,
    acpRegistry: false,
    agentId: "codex",
    displayName: "Codex",
    featured: true,
    accountSetup: true,
    fields: [
      {
        key: "setupMode",
        type: "select",
        visibility: "hidden",
        default: "existing",
        label: "Mode",
        options: [
          { value: "existing", label: "existing" },
          { value: "managed", label: "managed" },
        ],
      },
    ],
  }
  const { wizard, create } = await openWizard({ extras: [codex] })
  expect(wizard.getByRole("option", { name: "Codex" }).getAttribute("aria-selected")).toBe("true")
  await userEvent.click(wizard.getByRole("button", { name: "使用 ChatGPT 账号" }))
  const name = wizard.getByRole("textbox", { name: "账号名称" })
  await userEvent.clear(name)
  await userEvent.type(name, "Work")
  await userEvent.click(wizard.getByRole("button", { name: "继续登录" }))
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      agentId: "codex",
      label: "ChatGPT - Work",
      values: { setupMode: "managed" },
    }),
  )
})
