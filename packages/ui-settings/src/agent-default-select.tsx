/** 「新会话使用」的下拉框：自动，或任一已启用的实例；选中项带品牌图标。 */
import { ChevronDown } from "lucide-react"
import { AgentIcon, Select, useLocale } from "@pigcode/ui-primitives"
import type { AgentInstanceEntry } from "./agent-instances"

const AUTO = ":auto"

export function DefaultInstanceSelect({
  choices,
  value,
  onChange,
}: {
  choices: readonly AgentInstanceEntry[]
  /** 当前生效的实例；null 表示自动。 */
  value: string | null
  onChange: (instanceId: string | null) => void
}) {
  const { t } = useLocale()
  return (
    <Select.Root
      value={value ?? AUTO}
      onValueChange={(next) => onChange(next === AUTO || next === null ? null : String(next))}
    >
      <Select.Trigger
        className="input select-trigger agents-default-trigger"
        aria-label={t("agents.default.title")}
      >
        <Select.Value className="grow truncate">
          {(current: string) => {
            if (current === AUTO) return t("agents.default.auto")
            const entry = choices.find((item) => item.instance.instanceId === current)
            if (!entry) return current
            return (
              <span className="agents-default-choice">
                <AgentIcon
                  agentId={entry.agent.agentId}
                  instanceId={entry.instance.instanceId}
                  accentColor={entry.instance.accentColor}
                  name={entry.label}
                  size="sm"
                />
                <span className="truncate">{entry.label}</span>
              </span>
            )
          }}
        </Select.Value>
        <ChevronDown className="ic ic-sm agent-select-caret" aria-hidden="true" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={6} alignItemWithTrigger={false}>
          <Select.Popup>
            <Select.Item value={AUTO}>
              <Select.ItemText>{t("agents.default.auto")}</Select.ItemText>
            </Select.Item>
            {choices.map((entry) => (
              <Select.Item key={entry.instance.instanceId} value={entry.instance.instanceId}>
                <AgentIcon
                  agentId={entry.agent.agentId}
                  instanceId={entry.instance.instanceId}
                  accentColor={entry.instance.accentColor}
                  name={entry.label}
                />
                <Select.ItemText>{entry.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}
