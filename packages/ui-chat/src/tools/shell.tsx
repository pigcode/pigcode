/**
 * 终端命令（参照 ZCode 的 execute）：运行中「正在执行」扫光，结束后「终端」，摘要是命令本身；
 * 失败时显示「执行失败」，悬停看退出码与输出开头。展开后是一张卡片：`$ 命令`（超过三行折叠）
 * 与输出区（最多五行，运行中跟随最新输出，往上翻时停下）。连续的命令合成「终端 · N 个命令」。
 */
import { memo, useLayoutEffect, useRef, useState } from "react"
import { ChevronDown, SquareTerminal } from "lucide-react"
import { useLocale } from "@pigcode/ui-primitives"
import { commandText, toolPreview, type ToolCall } from "../tool-meta"
import { ToolRow } from "../tool-row"
import { headLines, toolStatusWord } from "./common"

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g")

/** 去掉终端颜色等控制序列。 */
export function plainOutput(text: string): string {
  return text.replace(ANSI, "").replace(/\r\n?/g, "\n")
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  )
}

/** `$ 命令`：超过三行时折叠，可以展开看完整命令。 */
function CommandText({ command }: { command: string }) {
  const { t } = useLocale()
  const box = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  useLayoutEffect(() => {
    const element = box.current
    if (!element || expanded) return
    setOverflowing(element.scrollHeight > element.clientHeight + 1)
  }, [command, expanded])
  return (
    <div className="cmd-text">
      <div ref={box} className="cmd-text-body" data-expanded={expanded || undefined}>
        <span className="cmd-prompt" aria-hidden="true">
          $
        </span>
        <pre>{command}</pre>
      </div>
      {overflowing || expanded ? (
        <button
          type="button"
          className="cmd-more"
          aria-expanded={expanded}
          onClick={() => {
            if (box.current) box.current.scrollTop = 0
            setExpanded(!expanded)
          }}
        >
          {expanded
            ? t("chat.toolCall.execute.collapseCommand")
            : t("chat.toolCall.execute.expandCommand")}
          <ChevronDown className="ic ic-xs" aria-hidden="true" data-up={expanded || undefined} />
        </button>
      ) : null}
    </div>
  )
}

/** 输出区：运行中跟随最新输出，用户往上翻时停止跟随，翻回底部后继续。 */
function CommandOutput({ text, running }: { text: string; running: boolean }) {
  const { t } = useLocale()
  const scroller = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const output = plainOutput(text)
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/\n+$/, "")
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && following) element.scrollTop = element.scrollHeight
  }, [output, following])
  if (!output.trim()) {
    return (
      <p className="cmd-output is-empty">
        {running ? t("chat.toolCall.execute.waiting") : t("chat.toolCall.execute.noOutput")}
      </p>
    )
  }
  return (
    <div
      ref={scroller}
      className="cmd-output"
      tabIndex={0}
      aria-label={t("chat.tool.output")}
      onScroll={(event) => {
        const element = event.currentTarget
        setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight <= 8)
      }}
    >
      <pre>{output}</pre>
    </div>
  )
}

/** 一条终端命令。live 是运行中已经流出的输出。 */
export const CommandRow = memo(function CommandRow({
  tool,
  live,
  showIcon = true,
}: {
  tool: ToolCall
  live?: string | undefined
  showIcon?: boolean | undefined
}) {
  const { t } = useLocale()
  const running = tool.status === "running"
  const command = commandText(tool.input) ?? toolPreview(tool.input) ?? ""
  const output = running ? (live ?? "") : (tool.output ?? "")
  const failed = tool.status === "failed"
  const reason = failed
    ? [
        tool.exitCode !== undefined
          ? t("chat.toolCall.execute.exit").replace("{code}", String(tool.exitCode))
          : null,
        headLines(plainOutput(output)),
      ]
        .filter(Boolean)
        .join("\n")
    : undefined
  return (
    <ToolRow
      id={tool.id}
      icon={SquareTerminal}
      showIcon={showIcon}
      kind={running ? t("chat.toolCall.execute.running") : t("chat.toolCall.kind.terminal")}
      running={running}
      secondary={<code className="cmd-summary">{firstLine(command)}</code>}
      hideSecondaryWhenOpen
      status={toolStatusWord(t, tool, reason)}
      title={command}
      className="cmd-row"
      dataStatus={tool.status}
    >
      {() => (
        <div className="tool-card cmd-card">
          <CommandText command={command} />
          <CommandOutput text={output} running={running} />
        </div>
      )}
    </ToolRow>
  )
})

/** 连续的命令合成一行「终端 · N 个命令，M 个失败」，运行中显示正在执行的命令。 */
export const CommandGroup = memo(function CommandGroup({
  tools,
  liveOutput,
}: {
  tools: readonly ToolCall[]
  liveOutput?: Readonly<Record<string, string>> | undefined
}) {
  const { t } = useLocale()
  const running = tools.some((tool) => tool.status === "running")
  const failed = tools.filter((tool) => tool.status === "failed").length
  const stopped = tools.filter((tool) => tool.status === "stopped").length
  const count = t(
    tools.length === 1
      ? "chat.toolCall.executeGroup.commands.one"
      : "chat.toolCall.executeGroup.commands.other",
  ).replace("{count}", String(tools.length))
  const summary = [
    count,
    failed > 0 ? t("chat.toolCall.executeGroup.failed").replace("{count}", String(failed)) : null,
    stopped > 0
      ? t("chat.toolCall.executeGroup.stopped").replace("{count}", String(stopped))
      : null,
  ]
    .filter(Boolean)
    .join(", ")
  const active = [...tools].reverse().find((tool) => tool.status === "running")
  return (
    <ToolRow
      id={`commands-${tools[0]?.id ?? ""}`}
      icon={SquareTerminal}
      kind={t("chat.toolCall.kind.terminal")}
      running={running}
      separator
      primary={running ? t("chat.toolCall.execute.running") : summary}
      secondary={
        running && active ? (
          <code className="cmd-summary">{firstLine(commandText(active.input) ?? "")}</code>
        ) : undefined
      }
      expandedPrimary={summary}
      hideSecondaryWhenOpen
      className="tool-group cmd-group"
      dataStatus={running ? "running" : failed > 0 ? "failed" : "completed"}
    >
      {() => (
        <div className="tool-children">
          {tools.map((tool) => (
            <CommandRow key={tool.id} tool={tool} live={liveOutput?.[tool.id]} showIcon={false} />
          ))}
        </div>
      )}
    </ToolRow>
  )
})
