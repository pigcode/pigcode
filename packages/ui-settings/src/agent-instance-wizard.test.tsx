// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import type { AgentSummary } from "@pigcode/contracts"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { AgentsPage } from "./agents-page"

afterEach(cleanup)

const acp: AgentSummary = {
  agentId: "acp",
  displayName: "ACP",
  pluginId: "agent.@pigcode/agent-acp",
  version: "0.1.0",
  builtin: true,
  enabled: true,
  registered: true,
  features: null,
  acpRegistry: true,
  description: null,
  homepage: null,
  installHint: null,
  fields: [
    { key: "binaryPath", type: "path", pathKind: "file", label: "可执行文件" },
    { key: "arguments", type: "arguments", label: "启动参数" },
    { key: "registryId", type: "text", label: "ACP Registry ID" },
  ],
  customModels: false,
  values: {},
  error: null,
  instances: [],
}

async function openAcpWizard() {
  const onCreateInstance = vi.fn(async () => "acp-new")
  const onUpdateCli = vi.fn(async () => undefined)
  const noop = async () => undefined
  render(
    <LocaleProvider locale="zh-CN">
      <AgentsPage
        agents={[acp]}
        defaultAgentId={null}
        statuses={{}}
        onDetect={noop}
        onSetEnabled={noop}
        onSaveSettings={noop}
        onSetDefault={noop}
        onUpdateInstance={noop}
        onRemoveInstance={noop}
        onCreateInstance={onCreateInstance}
        onUpdateCli={onUpdateCli}
        loadAcpRegistry={async () => [
          {
            id: "fixture",
            name: "Registry fixture",
            description: "Fixture",
            version: "1.0.0",
            distribution: "binary",
          },
        ]}
      />
    </LocaleProvider>,
  )
  await userEvent.click(screen.getByRole("button", { name: "添加实例" }))
  const options = within(screen.getByRole("dialog")).getAllByRole("option")
  expect(options).toHaveLength(1)
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("option", { name: "ACP" }))
  return { onCreateInstance, onUpdateCli }
}

const next = () => userEvent.click(screen.getByRole("button", { name: "下一步" }))
const create = () => userEvent.click(screen.getByRole("button", { name: "创建实例" }))

it("preserves spaces in the local ACP executable and literal arguments", async () => {
  const { onCreateInstance, onUpdateCli } = await openAcpWizard()
  await userEvent.click(screen.getByRole("button", { name: "使用已有命令" }))
  await next()
  await userEvent.type(screen.getByRole("textbox", { name: "实例名称" }), "Local")
  await next()
  await userEvent.type(screen.getByRole("textbox", { name: "可执行文件" }), "/path/to/acp command")
  fireEvent.change(screen.getByRole("textbox", { name: "启动参数" }), {
    target: { value: "acp\nwith spaces" },
  })
  await create()
  expect(onCreateInstance).toHaveBeenCalledWith(
    expect.objectContaining({
      agentId: "acp",
      label: "Local",
      values: { binaryPath: "/path/to/acp command", arguments: ["acp", "with spaces"] },
    }),
  )
  expect(onUpdateCli).not.toHaveBeenCalled()
})

async function chooseRegistryAgent() {
  await userEvent.click(await screen.findByRole("option", { name: /Registry fixture/ }))
  await next()
  await next()
}

it("starts managed installation when adding a Registry instance", async () => {
  const { onCreateInstance, onUpdateCli } = await openAcpWizard()
  await chooseRegistryAgent()
  expect(onUpdateCli).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole("button", { name: "添加并安装" }))
  expect(onCreateInstance).toHaveBeenCalledWith(
    expect.objectContaining({
      agentId: "acp",
      label: "Registry fixture",
      values: { registryId: "fixture" },
    }),
  )
  expect(onUpdateCli).toHaveBeenCalledExactlyOnceWith("acp-new")
})

it("keeps the Registry entry when an existing executable supplies its runtime", async () => {
  const { onCreateInstance, onUpdateCli } = await openAcpWizard()
  await chooseRegistryAgent()
  await userEvent.type(screen.getByRole("textbox", { name: "可执行文件" }), "fixture-acp")
  await create()
  expect(onCreateInstance).toHaveBeenCalledWith(
    expect.objectContaining({
      values: { registryId: "fixture", binaryPath: "fixture-acp" },
    }),
  )
  expect(onUpdateCli).not.toHaveBeenCalled()
})
