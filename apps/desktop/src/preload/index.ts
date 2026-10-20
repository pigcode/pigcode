/** preload：只把 main 转交的 MessagePort 转交给渲染主世界；不暴露 Node。 */
import { ipcRenderer } from "electron"

ipcRenderer.on("pigcode:port", (event) => {
  const [port] = event.ports
  if (port) window.postMessage({ type: "pigcode:port" }, "*", [port])
})
