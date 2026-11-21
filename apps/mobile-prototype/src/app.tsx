/**
 * 三套方案共用一个外框：电脑浏览器里画成一台 393×852 的手机，切换条浮在底部；
 * 手机上铺满屏幕，切换条放在最上面一条，可以收起。
 */
import { useEffect, useMemo, useState } from "react"
import { BatteryFull, SignalHigh, SlidersHorizontal, Wifi } from "lucide-react"
import { NavContext, useUrlState, type Nav, type Place } from "./nav"
import { store } from "./store"
import { Switcher } from "./switcher"
import { VariantA } from "./variant-a"
import { VariantB } from "./variant-b"
import { VariantC } from "./variant-c"

function useWide(): boolean {
  const query = "(min-width: 640px)"
  const [wide, setWide] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const onChange = () => setWide(media.matches)
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [])
  return wide
}

function useTheme(theme: "system" | "light" | "dark"): void {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const apply = () => {
      document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "dark" : "light") : theme
    }
    apply()
    media.addEventListener("change", apply)
    return () => media.removeEventListener("change", apply)
  }, [theme])
}

export function App() {
  const [state, update] = useUrlState()
  const wide = useWide()
  const [hidden, setHidden] = useState(false)
  useTheme(state.theme)

  useEffect(() => {
    store.setConn(state.conn)
  }, [state.conn])

  const nav = useMemo<Nav>(() => {
    const placePatch = (place: Place) => ({ screen: place.screen, thread: place.thread, file: place.file })
    return {
      place: { screen: state.screen, thread: state.thread, file: state.file },
      conn: state.conn,
      variant: state.variant,
      go: (place) => update(placePatch(place), true),
      replace: (place) => update(placePatch(place)),
      back: (fallback) => {
        if ((window.history.state as { inApp?: boolean } | null)?.inApp) window.history.back()
        else update(placePatch(fallback))
      },
    }
  }, [state, update])

  const body = state.variant === "A" ? <VariantA /> : state.variant === "B" ? <VariantB /> : <VariantC />
  const switcher = import.meta.env.DEV ? (
    <Switcher state={state} update={update} onHide={wide ? undefined : () => setHidden(true)} />
  ) : null

  return (
    <NavContext.Provider value={nav}>
      <div className="proto-root" data-wide={wide || undefined} data-switcher={hidden ? "hidden" : undefined}>
        {!wide && !hidden ? switcher : null}
        <div className="proto-stage">
          <div className="m-app" data-variant={state.variant} key={state.variant}>
            {wide ? (
              <div className="m-statusbar" aria-hidden="true">
                <span>9:41</span>
                <span className="m-statusbar-icons">
                  <SignalHigh className="ic" />
                  <Wifi className="ic" />
                  <BatteryFull className="ic" />
                </span>
              </div>
            ) : null}
            {body}
            {wide ? <div className="m-homebar" aria-hidden="true" /> : null}
          </div>
        </div>
        {wide ? switcher : null}
        {!wide && hidden && import.meta.env.DEV ? (
          <button type="button" className="proto-reveal" aria-label="展开切换条" onClick={() => setHidden(false)}>
            <SlidersHorizontal className="ic" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </NavContext.Provider>
  )
}
