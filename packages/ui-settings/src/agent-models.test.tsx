/** 验证实例的模型列表：按草稿排序与隐藏、开关、上下移、全部显示，以及自定义模型的添加与移除。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AgentSettingsValues } from "@pigcode/contracts"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { ModelsEditor, arrangeModels, type AgentModelInfo, type ModelsPatch } from "./agent-models"

afterEach(cleanup)

const CATALOG: AgentModelInfo[] = [
  { id: "default", label: "Default (recommended)", isDefault: true },
  { id: "opus", label: "Opus 5.5", fast: true },
  { id: "haiku", label: "Haiku 5.5" },
]

/** 像编辑器一样把改动合进草稿，并记下每次改动。 */
function Harness({
  initial,
  onPatch,
}: {
  initial: AgentSettingsValues
  onPatch: (patch: ModelsPatch, next: AgentSettingsValues) => void
}) {
  const [values, setValues] = useState(initial)
  return (
    <ModelsEditor
      catalog={CATALOG}
      values={values}
      allowCustom
      onChange={(patch) => {
        const next = { ...values, ...patch }
        setValues(next)
        onPatch(patch, next)
      }}
    />
  )
}

function renderEditor(initial: AgentSettingsValues = {}) {
  const onPatch = vi.fn()
  render(
    <LocaleProvider locale="zh-CN">
      <Harness initial={initial} onPatch={onPatch} />
    </LocaleProvider>,
  )
  const last = (): AgentSettingsValues => onPatch.mock.calls.at(-1)?.[1] ?? initial
  const names = () =>
    Array.from(
      screen.getByRole("list", { name: "模型" }).querySelectorAll(".agent-model-name"),
    ).map((item) => item.textContent)
  return { last, names }
}

describe("arrangeModels", () => {
  it("applies the draft order, keeps the rest in catalog order and marks hidden models", () => {
    const rows = arrangeModels(CATALOG, {
      customModels: ["my-model"],
      hiddenModels: ["opus"],
      modelOrder: ["my-model", "haiku"],
    })
    expect(rows.map((row) => row.id)).toEqual(["my-model", "haiku", "default", "opus"])
    expect(rows.find((row) => row.id === "my-model")?.custom).toBe(true)
    expect(rows.filter((row) => row.hidden).map((row) => row.id)).toEqual(["opus"])
  })

  it("does not repeat a custom model the catalog already lists", () => {
    const catalog = [...CATALOG, { id: "my-model", label: "my-model", custom: true }]
    const rows = arrangeModels(catalog, { customModels: ["my-model"] })
    expect(rows.filter((row) => row.id === "my-model")).toHaveLength(1)
  })
})

describe("ModelsEditor", () => {
  it("hides a model from the picker and moves another up", async () => {
    const { last, names } = renderEditor()
    expect(screen.getByText("3 个模型，3 个显示在选择器里")).toBeTruthy()

    await userEvent.click(screen.getByRole("switch", { name: "在选择器里显示 Haiku 5.5" }))
    expect(screen.getByText("3 个模型，2 个显示在选择器里")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "上移 Opus 5.5" }))
    expect(names()).toEqual(["Opus 5.5", "Default (recommended)", "Haiku 5.5"])
    // 第一行不能再上移，最后一行不能再下移。
    expect(screen.getByRole("button", { name: "上移 Opus 5.5" }).hasAttribute("disabled")).toBe(
      true,
    )
    expect(screen.getByRole("button", { name: "下移 Haiku 5.5" }).hasAttribute("disabled")).toBe(
      true,
    )
    expect(last()).toEqual({ hiddenModels: ["haiku"], modelOrder: ["opus", "default", "haiku"] })
  })

  it("lists saved preferences in order and brings hidden models back with Show all", async () => {
    const { last, names } = renderEditor({ hiddenModels: ["opus"], modelOrder: ["haiku"] })
    expect(names()[0]).toBe("Haiku 5.5")
    expect(
      screen.getByRole("switch", { name: "在选择器里显示 Opus 5.5" }).getAttribute("aria-checked"),
    ).toBe("false")
    await userEvent.click(screen.getByRole("button", { name: "全部显示" }))
    expect(
      screen.getByRole("switch", { name: "在选择器里显示 Opus 5.5" }).getAttribute("aria-checked"),
    ).toBe("true")
    expect(last().hiddenModels).toEqual([])
    expect(screen.queryByRole("button", { name: "全部显示" })).toBeNull()
  })

  it("adds a custom model, rejects duplicates and removes it from every list", async () => {
    const { last, names } = renderEditor()
    const input = screen.getByRole("textbox", { name: "模型 id，回车添加" })
    await userEvent.type(input, "opus{Enter}")
    expect(screen.getByText("目录里已经有这个模型")).toBeTruthy()
    await userEvent.clear(input)
    await userEvent.type(input, "my-model{Enter}")
    expect(names().at(-1)).toBe("my-model")
    await userEvent.click(screen.getByRole("switch", { name: "在选择器里显示 my-model" }))
    await userEvent.click(screen.getByRole("button", { name: "上移 my-model" }))

    await userEvent.click(screen.getByRole("button", { name: "移除 my-model" }))
    expect(names()).not.toContain("my-model")
    expect(last()).toEqual({
      customModels: [],
      hiddenModels: [],
      modelOrder: ["default", "opus", "haiku"],
    })
  })
})
