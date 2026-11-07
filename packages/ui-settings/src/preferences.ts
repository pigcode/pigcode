/** 主进程管的应用偏好：通用设置页和定时任务页都从这里读写，和主进程的 Preferences 一致。 */
import { useEffect, useRef, useState } from "react"

/** 主进程要应用的偏好：开机自启、Dock 图标、自动检查更新，以及打开时保持电脑唤醒。 */
export interface Preferences {
  launchAtLogin: boolean
  showInDock: boolean
  autoCheckUpdates: boolean
  prereleaseUpdates: boolean
  keepAwake: boolean
}

/** 本机桥里读写偏好的两个方法；页面不依赖主应用的全局类型。 */
interface PreferencesBridge {
  getPreferences?: () => Promise<Preferences>
  setPreference?: (key: keyof Preferences, value: boolean) => Promise<Preferences>
}

function bridge(): PreferencesBridge | undefined {
  return (globalThis as { pigcodeNative?: PreferencesBridge }).pigcodeNative
}

const DEFAULTS: Preferences = {
  launchAtLogin: false,
  showInDock: true,
  autoCheckUpdates: true,
  prereleaseUpdates: false,
  keepAwake: false,
}

/** 读主进程的偏好；读到之前用默认值，开关不会在加载时闪一下。 */
export function usePreferences(): [Preferences, (key: keyof Preferences, value: boolean) => void] {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULTS)
  // 用户已经动过开关时，晚到的读取结果不能把刚改的值盖回去。
  const changed = useRef(false)
  useEffect(() => {
    void bridge()
      ?.getPreferences?.()
      .then(
        (loaded) => {
          if (!changed.current) setPrefs({ ...DEFAULTS, ...loaded })
        },
        () => undefined,
      )
  }, [])
  const update = (key: keyof Preferences, value: boolean): void => {
    changed.current = true
    const before = prefs
    setPrefs((current) => ({ ...current, [key]: value }))
    void bridge()
      ?.setPreference?.(key, value)
      .then(
        (saved) => setPrefs({ ...DEFAULTS, ...saved }),
        () => {
          // 写不进去（磁盘满、桥不可用）时回到原来的样子，别让开关和实际设置对不上。
          if (bridge()?.setPreference) setPrefs(before)
        },
      )
  }
  return [prefs, update]
}
