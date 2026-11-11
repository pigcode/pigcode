// 外观设置页：模式（三扇窗口缩略图），主题工作台（大预览、主题列表、五种颜色），主题代码面板，
// 字体与对比度，动态效果。所有修改经 useAppearance 的 update 立即生效并保存。
import { useCallback, useEffect, useState } from "react"
import { RotateCcw } from "lucide-react"
import {
  Button,
  SegmentedControl,
  SettingPage,
  SettingRow,
  SettingSection,
  Switch,
  activeSlot,
  colorKeys,
  editSlot,
  findTheme,
  resetMode,
  setOverride,
  setUiFont,
  themeSwatch,
  supportsTranslucency,
  useAppearance,
  useLocale,
  type AppearanceController,
  type AppearanceSettings,
  type ColorKey,
  type Hex,
  type ThemeSlot,
} from "@pigcode/ui-primitives"
import { ThemeCodePanel } from "./appearance-code"
import { ColorChips, FontField, SliderRow } from "./appearance-fields"
import { MiniWindow, ModePicker, ThemeGallery } from "./appearance-preview"
import {
  ThemeTransferActions,
  TransferNoticeLine,
  type TransferNotice,
} from "./appearance-transfer"

/** 动态效果偏好。 */
type MotionPreference = "system" | "on" | "off"

type Mode = "light" | "dark"

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

/** 哪些颜色是用户改过的：强调色看是否用自定义强调色，其余看有没有修改。 */
function changedColors(appearance: AppearanceController, mode: Mode): Record<ColorKey, boolean> {
  const { settings, customThemes } = appearance
  const slot = activeSlot(settings, mode)
  const overrides = settings.overrides[findTheme(slot.themeId, customThemes).id]?.[mode] ?? {}
  const changed = {} as Record<ColorKey, boolean>
  for (const key of colorKeys) {
    changed[key] = key === "accent" ? slot.accentMode === "custom" : overrides[key] !== undefined
  }
  return changed
}

/** 删掉一套「我的主题」后：用着它的模式换回 pigcode，它的颜色修改一起清掉。 */
function withoutTheme(settings: AppearanceSettings, themeId: string): AppearanceSettings {
  const next = { ...settings }
  // 直接改两个主题槽，不经过 editSlot：删除主题不该顺带打开「浅色、深色分别设置」
  for (const mode of ["light", "dark"] as const) {
    if (next[mode].themeId === themeId) {
      next[mode] = { ...next[mode], themeId: "pigcode", accentMode: "default" }
    }
  }
  const overrides = { ...next.overrides }
  delete overrides[themeId]
  return { ...next, overrides }
}

/** 主题工作台：上面是当前主题的大预览，中间是主题列表，下面是五种颜色。 */
function ThemeStudio({ appearance, mode }: { appearance: AppearanceController; mode: Mode }) {
  const { t } = useLocale()
  const { settings, customThemes, update } = appearance
  const colors = themeSwatch(settings, customThemes, mode, activeSlot(settings, mode).themeId)
  const changed = changedColors(appearance, mode)
  const modeLabel = t(
    mode === "light" ? "settings.appearance.lightTheme" : "settings.appearance.darkTheme",
  )
  const setColor = (key: ColorKey, value: Hex | null) =>
    update((current) => {
      const patch: Partial<ThemeSlot> =
        key === "accent" ? { accentMode: value ? "custom" : "default" } : {}
      return setOverride(editSlot(current, mode, patch), mode, key, value)
    })

  return (
    <div className="theme-studio">
      <div className="theme-stage">
        <MiniWindow colors={colors} detail />
      </div>
      <ThemeGallery
        appearance={appearance}
        mode={mode}
        onPick={(themeId) => update((current) => editSlot(current, mode, { themeId }))}
        onRemove={(themeId) => {
          appearance.removeCustomTheme(themeId)
          update((current) => withoutTheme(current, themeId))
        }}
      />
      <div className="theme-colors">
        <ColorChips
          prefix={modeLabel}
          colors={colors}
          changed={changed}
          keys={colorKeys}
          onChange={setColor}
        />
        <Button
          variant="ghost"
          size="sm"
          className="theme-colors-reset"
          disabled={!colorKeys.some((key) => changed[key])}
          onClick={() => update((current) => resetMode(current, mode))}
        >
          <RotateCcw className="ic ic-sm" aria-hidden="true" />
          {t("settings.appearance.resetMode")}
        </Button>
      </div>
    </div>
  )
}

/** 外观设置内容；所有修改经 appearance.update 立即生效并保存。 */
function AppearancePageContent({ appearance }: { appearance: AppearanceController }) {
  const { t } = useLocale()
  const { settings, update, resolved } = appearance
  // 正在编辑哪一套颜色：默认是眼下显示的那套，切到浅色或深色模式时跟着切
  const [editing, setEditing] = useState<Mode>(resolved)
  useEffect(() => setEditing(resolved), [resolved])
  const [notice, setNotice] = useState<TransferNotice | null>(null)
  const clearNotice = useCallback(() => setNotice(null), [])
  const native = (globalThis as { pigcodeNative?: { platform?: string; systemVersion?: string } })
    .pigcodeNative
  const canTranslucent = supportsTranslucency(native?.platform ?? "", native?.systemVersion)

  return (
    <SettingPage title={t("settings.appearance.pageTitle")}>
      <div className="appearance-page">
        <SettingSection title={t("settings.appearance.mode")} plain>
          <ModePicker
            appearance={appearance}
            onPick={(mode) => update((current) => ({ ...current, mode }))}
          />
        </SettingSection>
        <SettingSection
          title={t("settings.appearance.theme")}
          plain
          actions={
            <>
              <ThemeTransferActions
                appearance={appearance}
                onNotice={setNotice}
                onImported={(modes) => {
                  if (modes.length === 1 && modes[0]) setEditing(modes[0])
                }}
              />
              <SegmentedControl<Mode>
                aria-label={t("settings.appearance.editing")}
                value={editing}
                onValueChange={setEditing}
                options={[
                  { value: "light", label: t("settings.appearance.light") },
                  { value: "dark", label: t("settings.appearance.dark") },
                ]}
              />
            </>
          }
        >
          <TransferNoticeLine notice={notice} onDone={clearNotice} />
          <ThemeStudio appearance={appearance} mode={editing} />
        </SettingSection>
        <SettingSection title={t("settings.appearance.code")} plain>
          <p className="section-note">{t("settings.appearance.code.description")}</p>
          <ThemeCodePanel appearance={appearance} mode={editing} />
        </SettingSection>
        <SettingSection title={t("settings.appearance.fonts")}>
          <SettingRow
            title={t("settings.appearance.uiFont")}
            description={t("settings.appearance.font.description")}
          >
            <FontField
              kind="ui"
              label={t("settings.appearance.uiFont")}
              value={settings.light.uiFont}
              onChange={(uiFont) => update((current) => setUiFont(current, uiFont))}
            />
          </SettingRow>
          <SettingRow title={t("settings.appearance.codeFont")}>
            <FontField
              kind="code"
              label={t("settings.appearance.codeFont")}
              value={settings.codeFont}
              onChange={(codeFont) => update((current) => ({ ...current, codeFont }))}
            />
          </SettingRow>
          <SettingRow title={t("settings.appearance.uiSize")}>
            <SliderRow
              label={t("settings.appearance.uiSize")}
              value={settings.uiSize}
              min={11}
              max={18}
              step={0.5}
              onChange={(uiSize) => update((current) => ({ ...current, uiSize }))}
            />
          </SettingRow>
          <SettingRow title={t("settings.appearance.contentSize")}>
            <SliderRow
              label={t("settings.appearance.contentSize")}
              value={settings.contentSize}
              min={11}
              max={20}
              step={0.5}
              onChange={(contentSize) => update((current) => ({ ...current, contentSize }))}
            />
          </SettingRow>
          <SettingRow title={t("settings.appearance.codeSize")}>
            <SliderRow
              label={t("settings.appearance.codeSize")}
              value={settings.codeSize}
              min={10}
              max={18}
              step={0.5}
              onChange={(codeSize) => update((current) => ({ ...current, codeSize }))}
            />
          </SettingRow>
          <SettingRow
            title={t("settings.appearance.contrast")}
            description={t("settings.appearance.contrast.description")}
          >
            <SliderRow
              label={t("settings.appearance.contrast")}
              value={settings.contrast}
              min={0}
              max={100}
              step={1}
              onChange={(contrast) => update((current) => ({ ...current, contrast }))}
            />
          </SettingRow>
        </SettingSection>
        <SettingSection title={t("settings.appearance.window")}>
          <SettingRow
            title={t("settings.appearance.sidebarTranslucency")}
            description={t(
              canTranslucent
                ? "settings.appearance.sidebarTranslucency.description"
                : "settings.appearance.sidebarTranslucency.unsupported",
            )}
          >
            <SliderRow
              label={t("settings.appearance.sidebarTranslucency")}
              value={canTranslucent ? settings.sidebarTranslucency : 0}
              min={0}
              max={100}
              step={5}
              disabled={!canTranslucent}
              onChange={(sidebarTranslucency) =>
                update((current) => ({ ...current, sidebarTranslucency }))
              }
            />
          </SettingRow>
        </SettingSection>
        <SettingSection title={t("settings.appearance.motion")}>
          <SettingRow title={t("settings.appearance.motion")}>
            <SegmentedControl<MotionPreference>
              aria-label={t("settings.appearance.motion")}
              value={settings.motion}
              onValueChange={(motion) => update((current) => ({ ...current, motion }))}
              options={[
                { value: "system", label: t("settings.appearance.motion.system") },
                { value: "on", label: t("settings.appearance.motion.on") },
                { value: "off", label: t("settings.appearance.motion.off") },
              ]}
            />
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
      </div>
    </SettingPage>
  )
}
