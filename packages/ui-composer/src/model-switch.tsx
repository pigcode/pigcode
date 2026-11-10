/**
 * 模型选择器底栏的模式开关：快速模式（闪电）与 Ultracode（工作流）。没开时是灰色描边图标，开着时是实心图标加浅底；
 * 当前模型不支持时置灰，悬停说明原因。两个开关都按模型记在本机，下一次发送生效。
 */
import { Workflow, Zap, type LucideIcon } from "lucide-react"
import { useLocale, type MessageKey } from "@pigcode/ui-primitives"
import type { ModelSwitch } from "./composer-options"

/** 每个开关的图标与文案。 */
const SWITCHES: Record<
  ModelSwitch,
  { icon: LucideIcon; label: MessageKey; hint: MessageKey; unsupported: MessageKey }
> = {
  fast: {
    icon: Zap,
    label: "composer.speed.toggle",
    hint: "composer.speed.fastHint",
    unsupported: "composer.speed.unsupported",
  },
  ultracode: {
    icon: Workflow,
    label: "composer.ultracode.toggle",
    hint: "composer.ultracode.hint",
    unsupported: "composer.ultracode.unsupported",
  },
}

/** 胶囊上和读屏里的开关名。 */
export function switchLabel(name: ModelSwitch, t: (key: MessageKey) => string): string {
  return t(SWITCHES[name].label)
}

/** 胶囊上开着的开关画成的小图标。 */
export function SwitchMark({ name }: { name: ModelSwitch }) {
  const Icon = SWITCHES[name].icon
  return <Icon className="ic ic-sm model-chip-switch" data-switch={name} aria-hidden="true" />
}

/** 底栏里的一个开关按钮。 */
export function SwitchButton({
  name,
  on,
  supported,
  onToggle,
}: {
  name: ModelSwitch
  on: boolean
  supported: boolean
  onToggle: () => void
}) {
  const { t } = useLocale()
  const { icon: Icon, label, hint, unsupported } = SWITCHES[name]
  return (
    <button
      type="button"
      className="model-switch"
      data-switch={name}
      aria-label={t(label)}
      aria-pressed={on}
      disabled={!supported}
      title={supported ? `${t(label)} · ${t(hint)}` : t(unsupported)}
      onClick={onToggle}
    >
      <Icon className="ic" aria-hidden="true" />
    </button>
  )
}
