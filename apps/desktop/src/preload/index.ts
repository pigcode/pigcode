/** preload：MessagePort 转交 + 最小窗口/主题桥；不暴露 Node。 */
import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("pigcodeNative", {
  platform: process.platform,
  setThemeSource: (source: "light" | "dark" | "system") =>
    ipcRenderer.invoke("pigcode:set-theme", source),
  windowControl: (action: "minimize" | "maximize" | "close") =>
    ipcRenderer.invoke("pigcode:window", action),
  isMaximized: () => ipcRenderer.invoke("pigcode:is-maximized"),
})

ipcRenderer.on("pigcode:port", (event) => {
  const [port] = event.ports
  if (port) window.postMessage({ type: "pigcode:port" }, "*", [port])
})
