/**
 * 模型选择器底栏的思考深度滑块：一条胶囊形的轨道，最左一档是「默认」（不发档位，由 agent 自己决定），
 * 往右是当前模型支持的档位；选中的档位以左填满强调色，每档一个圆点。拖动、点轨道或用方向键都能选，
 * 当前档位的名字写在滑块右边。没有档位的模型画一条置灰的轨道，悬停说明原因，底栏不因换模型而跳动。
 */
import type { CSSProperties } from "react"
import { Slider, useLocale } from "@pigcode/ui-primitives"
import { effortLabel, type ReasoningEffort } from "./composer-options"

export function EffortControl({
  efforts,
  value,
  modelLabel,
  onChange,
}: {
  efforts: readonly ReasoningEffort[]
  value: ReasoningEffort | null
  modelLabel: string
  onChange: (effort: ReasoningEffort | null) => void
}) {
  const { t } = useLocale()
  const label = t("composer.effort.label")
  if (efforts.length === 0) {
    return (
      <div
        className="model-effort is-empty"
        title={t("composer.effort.unavailable").replace("{model}", modelLabel)}
      >
        <span className="model-effort-label">{label}</span>
        <span
          className="model-effort-track is-off"
          style={{ "--effort-steps": 4 } as CSSProperties}
        />
        <span className="model-effort-value">—</span>
      </div>
    )
  }
  const stops: (ReasoningEffort | null)[] = [null, ...efforts]
  const max = stops.length - 1
  const selected = value ? stops.indexOf(value) : 0
  const labelOf = (stop: ReasoningEffort | null) =>
    stop ? effortLabel(stop, t) : t("composer.effort.default")
  return (
    <div className="model-effort">
      <span className="model-effort-label">{label}</span>
      <Slider.Root
        className="model-effort-slider"
        min={0}
        max={max}
        step={1}
        value={selected}
        onValueChange={(next) => onChange(stops[next as number] ?? null)}
        style={{ "--effort-steps": max } as CSSProperties}
      >
        {/* 胶囊两端各留半个圆钮宽，圆钮在两端也不出界；填充从胶囊左端画到圆钮右缘 */}
        {selected > 0 ? (
          <span
            className="model-effort-fill"
            style={{
              width: `calc(var(--model-effort-thumb) + (100% - var(--model-effort-thumb)) * ${selected / max})`,
            }}
          />
        ) : null}
        <Slider.Control className="model-effort-control">
          <Slider.Track className="model-effort-track">
            {stops.map((stop, at) =>
              at === selected ? null : (
                <span
                  key={stop ?? "default"}
                  className="model-effort-dot"
                  data-default={at === 0 ? "" : undefined}
                  data-on={at < selected ? "" : undefined}
                  style={{ left: `${(at / max) * 100}%` }}
                />
              ),
            )}
            <Slider.Thumb
              className="model-effort-thumb"
              getAriaLabel={() => label}
              getAriaValueText={(_formatted, next) => labelOf(stops[next] ?? null)}
            />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
      <span className="model-effort-value" data-default={value ? undefined : ""}>
        {labelOf(value)}
      </span>
    </div>
  )
}
