// 负责外观设置和「我的主题」在 localStorage 里的读写，含旧主题键的一次性迁移。
import type { AppearanceSettings } from "./appearance-settings"
import {
  parseAppearance,
  parseCustomThemes,
  parseStoredAppearance,
  serializeAppearance,
} from "./appearance-settings"
import type { ThemeDefinition } from "./theme-presets"

/** 外观设置的存储键。 */
export const appearanceKey = "pigclaude-appearance"
/** 「我的主题」的存储键。 */
export const customThemesKey = "pigclaude-themes"
/** 旧版只存浅色/深色/系统的键，读到后迁移并删除。 */
export const legacyThemeKey = "pigclaude-theme"

/** 读写所需的最小存储能力；window.localStorage 满足它。 */
export type AppearanceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

/**
 * 读出外观设置和我的主题。保证：新键读不到（没有或损坏）而旧键存在时，迁移成新键的 mode
 * 并写入，然后删除旧键；新键可读时以新键为准并清掉旧键。
 */
export function loadAppearance(storage: AppearanceStorage): {
  settings: AppearanceSettings
  customThemes: ThemeDefinition[]
} {
  const raw = storage.getItem(appearanceKey)
  const legacy = storage.getItem(legacyThemeKey)
  const stored = raw === null ? null : parseStoredAppearance(raw)
  const settings = stored ?? parseAppearance(null, legacy)
  if (legacy !== null) {
    if (stored === null) storage.setItem(appearanceKey, serializeAppearance(settings))
    storage.removeItem(legacyThemeKey)
  }
  return { settings, customThemes: parseCustomThemes(storage.getItem(customThemesKey)) }
}

/** 保存外观设置。 */
export function saveAppearance(storage: AppearanceStorage, settings: AppearanceSettings): void {
  storage.setItem(appearanceKey, serializeAppearance(settings))
}

/** 保存我的主题。 */
export function saveCustomThemes(
  storage: AppearanceStorage,
  themes: readonly ThemeDefinition[],
): void {
  storage.setItem(customThemesKey, JSON.stringify(themes))
}
