import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { chromium } from "@playwright/test"
import { build } from "vite"

const root = new URL("../../../", import.meta.url)
const styles = new URL("packages/ui-primitives/src/styles/tokens.css", root)
const resolver = new URL("packages/ui-primitives/src/theme/resolve-color.ts", root)
const destination = new URL("apps/mobile/app/lib/theme_colors.dart", root)
const tokens = {
  background: "--bg",
  window: "--window",
  surface: "--surface",
  surfaceRaised: "--surface-raised",
  surfaceSunken: "--surface-sunken",
  panel: "--panel",
  field: "--field",
  switchTrack: "--track",
  switchOn: "--switch-on",
  switchThumb: "--knob",
  foreground: "--fg",
  secondaryText: "--fg-2",
  primary: "--primary",
  onPrimary: "--on-primary",
  divider: "--divider",
  border: "--border",
  strongBorder: "--border-strong",
  inputBackground: "--input-bg",
  inputBorder: "--input-border",
  timelineUser: "--cv-user-fill",
  timelineDivider: "--cv-hairline",
  timelineSubtle: "--cv-subtle",
  timelineFaint: "--cv-subtlest",
  timelinePanel: "--cv-panel",
  timelineCard: "--cv-card",
  timelineBorder: "--cv-border",
  timelineInlineCode: "--cv-inline-code",
  timelineDecoration: "--cv-decoration",
  hover: "--hover",
  link: "--link",
  timelineFile: "--file-node-fg",
  selected: "--active",
  error: "--bad-text",
  errorTint: "--bad-soft",
  onError: "--on-bad",
  muted: "--muted",
  faint: "--faint",
  attention: "--warn-text",
  attentionTint: "--warn-soft",
  attentionMark: "--warn",
  statusAccent: "--accent",
  readyMark: "--ok",
  running: "--info",
  online: "--ok-text",
  diffAdded: "--diff-add-fg",
  diffRemoved: "--diff-remove-fg",
  scrim: "--scrim",
}
const fills = {
  selectedOnSurface: ["--surface", "--active"],
  selectedOnBackground: ["--bg", "--active"],
  diffAddedBackground: ["--bg", "--diff-add-bg"],
  diffRemovedBackground: ["--bg", "--diff-remove-bg"],
}

const bundled = await build({
  configFile: false,
  logLevel: "error",
  build: {
    write: false,
    minify: false,
    lib: { entry: fileURLToPath(resolver), name: "PigcodeColors", formats: ["iife"] },
  },
})
const output = Array.isArray(bundled) ? bundled[0] : bundled
const compiled =
  output && "output" in output ? output.output.find((chunk) => chunk.type === "chunk") : undefined
if (!compiled) throw new Error("无法构建共享颜色解析器")

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.addStyleTag({ path: fileURLToPath(styles) })
  await page.addScriptTag({ content: compiled.code })
  const chunks = [
    "// 由 generate-mobile-theme.ts 生成。",
    "import 'package:flutter/widgets.dart';",
    "",
  ]
  for (const theme of ["light", "dark"]) {
    const colors = await page.evaluate(
      ({ theme, tokens, fills }) => {
        document.documentElement.dataset.theme = theme
        const { documentTokenReader, resolveCssColor } = (
          globalThis as typeof globalThis & {
            PigcodeColors: typeof import("../../../packages/ui-primitives/src/theme/resolve-color")
          }
        ).PigcodeColors
        const read = documentTokenReader()
        const colors = Object.entries(tokens).map(([name, token]) => {
          const hex = resolveCssColor(read(token))?.slice(1).toUpperCase()
          if (!hex) throw new Error("无法解析颜色 " + token)
          return [name, hex.length === 8 ? hex.slice(6) + hex.slice(0, 6) : "FF" + hex]
        })
        const canvas = document.createElement("canvas")
        canvas.width = canvas.height = 1
        const pixel = canvas.getContext("2d")
        if (!pixel) throw new Error("无法合成手机界面的填充颜色")
        for (const [name, layers] of Object.entries(fills)) {
          pixel.clearRect(0, 0, 1, 1)
          for (const token of layers) {
            pixel.fillStyle = read(token)
            pixel.fillRect(0, 0, 1, 1)
          }
          const rgba = pixel.getImageData(0, 0, 1, 1).data
          const hex = Array.from(rgba, (channel) => channel.toString(16).padStart(2, "0"))
            .join("")
            .toUpperCase()
          colors.push([name, hex.slice(6) + hex.slice(0, 6)])
        }
        return colors
      },
      { theme, tokens, fills },
    )
    chunks.push(theme === "light" ? "const pigcodeLight = (" : "const pigcodeDark = (")
    for (const [key, value] of colors) {
      chunks.push("  " + key + ": Color(0x" + value + "),")
    }
    chunks.push(");", "")
  }
  const generated = chunks.join("\n")
  if (process.argv.includes("--check")) {
    if ((await readFile(destination, "utf8")) !== generated) {
      throw new Error("手机颜色与桌面主题有差异，请重新运行 generate-mobile-theme.ts")
    }
  } else {
    await writeFile(destination, generated)
  }
} finally {
  await browser.close()
}
