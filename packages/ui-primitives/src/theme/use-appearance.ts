// 负责持有外观设置：读写本机存储，推导并写到根元素，并跟随系统深色与减少动态偏好。
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { applyAppearance } from "./apply-appearance"
import { loadAppearance, saveAppearance, saveCustomThemes } from "./appearance-storage"
import type { AppearanceSettings } from "./appearance-settings"
import type { AppearanceOutput } from "./appearance-tokens"
import { deriveAppearance } from "./appearance-tokens"
import { documentTokenReader, resolveCssColor } from "./resolve-color"
import type { ResolvedTheme } from "./theme-model"
import { resolveTheme } from "./theme-model"
import type { ThemeDefinition } from "./theme-presets"
import { titleBarColors } from "./theme-tokens"

const darkQuery = "(prefers-color-scheme: dark)"
const motionQuery = "(prefers-reduced-motion: reduce)"

/** 开发期用 ?theme=light|dark 强制主题；其他值忽略。 */
function parseDevTheme(search: string): ResolvedTheme | null {
  const value = new URLSearchParams(search).get("theme")
  return value === "light" || value === "dark" ? value : null
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const list = window.matchMedia(query)
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches)
    list.addEventListener("change", onChange)
    return () => list.removeEventListener("change", onChange)
  }, [query])
  return matches
}

/**
 * 外观设置的唯一入口。保证：初次渲染读本机存储（含旧键迁移）；每次设置变化都会保存、
 * 重新推导并写到 `<html>`，同时同步 data-theme、主进程窗口主题和原生标题栏颜色；开发期 ?theme= 优先。
 */
export function useAppearance() {
  const [initial] = useState(() => loadAppearance(window.localStorage))
  const [devTheme] = useState(() =>
    import.meta.env.DEV ? parseDevTheme(window.location.search) : null,
  )
  const [settings, setSettings] = useState<AppearanceSettings>(initial.settings)
  const [customThemes, setCustomThemes] = useState<ThemeDefinition[]>(initial.customThemes)
  const systemDark = useMediaQuery(darkQuery)
  const prefersReducedMotion = useMediaQuery(motionQuery)
  const resolved = devTheme ?? resolveTheme(settings.mode, systemDark)
  const previous = useRef<AppearanceOutput | null>(null)
  const reportedTitleBar = useRef("")

  const output = useMemo(
    () =>
      deriveAppearance(settings, customThemes, {
        resolved,
        glass: document.documentElement.dataset.glass === "true",
        platform: window.pigcodeNative?.platform ?? "",
        systemVersion: window.pigcodeNative?.systemVersion,
        prefersReducedMotion,
      }),
    [settings, customThemes, resolved, prefersReducedMotion],
  )

  useEffect(() => {
    document.documentElement.dataset.theme = resolved
  }, [resolved])

  useEffect(() => {
    applyAppearance(document.documentElement, output, previous.current)
    previous.current = output
  }, [output])

  // 写完变量后按 token 的计算值给原生标题栏上色，与页面 .titlebar 同源；颜色没变就不再上报。
  useEffect(() => {
    const native = window.pigcodeNative
    if (!native?.setTitleBarColors) return
    // 侧栏透明时 --window 是半透明的，读不成标题栏要的六位颜色；改读同色的不透明版本
    const tokens = documentTokenReader()
    const reader = (name: string) =>
      name === "--window" ? tokens("--window-solid") || tokens(name) : tokens(name)
    const colors = titleBarColors(reader, resolveCssColor)
    const key = colors ? `${colors.color}${colors.symbolColor}` : ""
    if (!colors || key === reportedTitleBar.current) return
    reportedTitleBar.current = key
    void native.setTitleBarColors(colors)
  }, [output, resolved])

  // 侧栏透明时让主进程把窗口底色设成透明，系统磨砂材质才能透出来
  const translucent = output.attrs["data-translucent"] === "true"
  useEffect(() => {
    void window.pigcodeNative?.setWindowTranslucent?.(translucent)
  }, [translucent])

  useEffect(() => {
    saveAppearance(window.localStorage, settings)
  }, [settings])

  useEffect(() => {
    saveCustomThemes(window.localStorage, customThemes)
  }, [customThemes])

  useEffect(() => {
    void window.pigcodeNative?.setThemeSource(settings.mode)
  }, [settings.mode])

  const saveCustomTheme = useCallback((theme: ThemeDefinition) => {
    setCustomThemes((current) =>
      current.some((item) => item.id === theme.id)
        ? current.map((item) => (item.id === theme.id ? theme : item))
        : [...current, theme],
    )
  }, [])
  const removeCustomTheme = useCallback((id: string) => {
    setCustomThemes((current) => current.filter((item) => item.id !== id))
  }, [])
  const renameCustomTheme = useCallback((id: string, name: string) => {
    setCustomThemes((current) => current.map((item) => (item.id === id ? { ...item, name } : item)))
  }, [])

  return {
    settings,
    customThemes,
    resolved,
    update: setSettings,
    saveCustomTheme,
    removeCustomTheme,
    renameCustomTheme,
  }
}

/** useAppearance 返回的控制器，供外观页和 Composer 调用方使用。 */
export type AppearanceController = ReturnType<typeof useAppearance>
