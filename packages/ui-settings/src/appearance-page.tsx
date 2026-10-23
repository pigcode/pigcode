// 外观设置页：模式、字号、动态效果和智能标点，全部复用 useAppearance。
import {
  SettingPage,
  SettingRow,
  SettingSection,
  Slider,
  Switch,
  Toggle,
  ToggleGroup,
  useAppearance,
  useLocale,
  type AppearanceController,
  type ThemePreference,
} from "@pigcode/ui-primitives"

/** 动态效果偏好。 */
type MotionPreference = "system" | "on" | "off"

/** 外观设置页；未传入控制器时自行调用 useAppearance，便于独立预览。 */
export function AppearancePage({ appearance }: { appearance?: AppearanceController | undefined }) {
  if (appearance) return <AppearancePageContent appearance={appearance} />
  return <StandaloneAppearancePage />
}

/** 独立挂载时由页面自己持有外观控制器。 */
function StandaloneAppearancePage() {
  const appearance = useAppearance()
  return <AppearancePageContent appearance={appearance} />
}

/** 字号滑块与右侧数值。 */
function SizeRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, width: 190 }}>
      <Slider.Root
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={(next) => {
          const first = typeof next === "number" ? next : next[0]
          if (first !== undefined) onChange(first)
        }}
      >
        <Slider.Control>
          <Slider.Track>
            <Slider.Indicator />
            <Slider.Thumb aria-label={label} />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
      <span className="num">{value}</span>
    </div>
  )
}

/** 外观设置内容；所有修改经 appearance.update 立即生效并保存。 */
function AppearancePageContent({ appearance }: { appearance: AppearanceController }) {
  const { t } = useLocale()
  const { settings, update } = appearance

  return (
    <SettingPage title={t("settings.appearance.pageTitle")}>
      <SettingSection title={t("settings.appearance.mode")}>
        <SettingRow title={t("settings.appearance.mode")}>
          <ToggleGroup<ThemePreference>
            multiple={false}
            value={[settings.mode]}
            onValueChange={(next) => {
              const mode = next[0]
              if (mode) update((current) => ({ ...current, mode }))
            }}
          >
            <Toggle value="system">{t("settings.appearance.system")}</Toggle>
            <Toggle value="light">{t("settings.appearance.light")}</Toggle>
            <Toggle value="dark">{t("settings.appearance.dark")}</Toggle>
          </ToggleGroup>
        </SettingRow>
        <SettingRow title={t("settings.appearance.uiSize")}>
          <SizeRow
            label={t("settings.appearance.uiSize")}
            value={settings.uiSize}
            min={11}
            max={18}
            step={0.5}
            onChange={(uiSize) => update((current) => ({ ...current, uiSize }))}
          />
        </SettingRow>
        <SettingRow title={t("settings.appearance.contentSize")}>
          <SizeRow
            label={t("settings.appearance.contentSize")}
            value={settings.contentSize}
            min={11}
            max={20}
            step={0.5}
            onChange={(contentSize) => update((current) => ({ ...current, contentSize }))}
          />
        </SettingRow>
      </SettingSection>
      <SettingSection title={t("settings.appearance.motion")}>
        <SettingRow title={t("settings.appearance.motion")}>
          <ToggleGroup<MotionPreference>
            multiple={false}
            value={[settings.motion]}
            onValueChange={(next) => {
              const motion = next[0]
              if (motion) update((current) => ({ ...current, motion }))
            }}
          >
            <Toggle value="system">{t("settings.appearance.motion.system")}</Toggle>
            <Toggle value="on">{t("settings.appearance.motion.on")}</Toggle>
            <Toggle value="off">{t("settings.appearance.motion.off")}</Toggle>
          </ToggleGroup>
        </SettingRow>
        <SettingRow
          title={t("settings.appearance.smartPunctuation")}
          description={t("settings.appearance.smartPunctuation.description")}
        >
          <Switch
            checked={settings.smartPunctuation}
            aria-label={t("settings.appearance.smartPunctuation")}
            onCheckedChange={(smartPunctuation) =>
              update((current) => ({ ...current, smartPunctuation }))
            }
          />
        </SettingRow>
      </SettingSection>
    </SettingPage>
  )
}
