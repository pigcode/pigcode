/**
 * 内置的工具行：每个工具族一行，按族名选。窗口把它们登记到工具渲染器扩展点上，测试也直接用它，
 * 所以改错一行会同时被两边的测试发现。
 */
import type { ReactNode } from "react"
import { AskToolRow } from "./ask-question"
import { BrowserRow } from "./browser"
import { EditRow, ReadRow } from "./files"
import { McpRow } from "./mcp"
import { SkillRow, TaskOutputRow, TaskStopRow } from "./misc"
import { PlanCard } from "./plan"
import { FetchRow, SearchRow } from "./search"
import { CommandRow } from "./shell"
import type { ToolRenderProps } from "./tool-block"
import type { ToolFamily } from "../tool-identity"

/** 内置的工具行按工具族选；族名来自 toolFamily。 */
export const BUILTIN_TOOL_ROWS: ReadonlyArray<[ToolFamily, (props: ToolRenderProps) => ReactNode]> =
  [
    [
      "shell",
      ({ tool, live, showIcon }) => <CommandRow tool={tool} live={live} showIcon={showIcon} />,
    ],
    ["file-read", ({ tool, showIcon }) => <ReadRow tool={tool} showIcon={showIcon} />],
    ["file-write", ({ tool, showIcon }) => <EditRow tool={tool} showIcon={showIcon} />],
    ["search", ({ tool, showIcon }) => <SearchRow tool={tool} showIcon={showIcon} />],
    ["web-fetch", ({ tool, showIcon }) => <FetchRow tool={tool} showIcon={showIcon} />],
    ["ask-user-question", ({ tool, showIcon }) => <AskToolRow tool={tool} showIcon={showIcon} />],
    ["skill", ({ tool, showIcon }) => <SkillRow tool={tool} showIcon={showIcon} />],
    ["task-output", ({ tool, showIcon }) => <TaskOutputRow tool={tool} showIcon={showIcon} />],
    ["task-stop", ({ tool, showIcon }) => <TaskStopRow tool={tool} showIcon={showIcon} />],
    // 计划卡片总是带图标，分组也不改变它。
    ["switch-mode", ({ tool }) => <PlanCard tool={tool} />],
    ["mcp", ({ tool, showIcon }) => <McpRow tool={tool} showIcon={showIcon} />],
    ["browser", ({ tool, showIcon }) => <BrowserRow tool={tool} showIcon={showIcon} />],
  ]
