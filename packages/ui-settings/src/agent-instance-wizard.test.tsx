// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import type { AgentSummary } from "@pigcode/contracts"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { InstanceCreateWizard } from "./agent-instance-wizard"

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

function renderWizard() {
  const onCreateInstance = vi.fn(async () => undefined)
  render(
    <LocaleProvider locale="zh-CN">
      <InstanceCreateWizard
        open
        onOpenChange={vi.fn()}
        agents={[acp]}
        onCreateInstance={onCreateInstance}
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
  return onCreateInstance
}

const next = () => userEvent.click(screen.getByRole("button", { name: "下一步" }))
const create = () => userEvent.click(screen.getByRole("button", { name: "创建实例" }))

it("preserves spaces in the local ACP executable and literal arguments", async () => {
  const onCreateInstance = renderWizard()
  await userEvent.click(screen.getByRole("option", { name: /本地 ACP 命令/ }))
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
})

it("creates a Registry instance with its own label and managed runtime selection", async () => {
  const onCreateInstance = renderWizard()
  await userEvent.click(screen.getByRole("option", { name: /ACP Registry/ }))
  await userEvent.click(await screen.findByRole("option", { name: /Registry fixture/ }))
  await next()
  await next()
  await create()
  expect(onCreateInstance).toHaveBeenCalledWith(
    expect.objectContaining({
      agentId: "acp",
      label: "Registry fixture",
      values: { registryId: "fixture" },
    }),
  )
})
