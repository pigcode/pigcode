/** 原型：手机端的主要界面（pigcode/monorepo#94）。监听所有网卡，同一 Wi‑Fi 下的手机才能打开。 */
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5199, strictPort: true },
})
