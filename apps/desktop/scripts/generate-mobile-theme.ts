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
  surface: "--surface",
  foreground: "--fg",
  secondaryText: "--fg-2",
  primary: "--primary",
  onPrimary: "--on-primary",
  divider: "--divider",
  selected: "--active",
  error: "--bad-text",
  onError: "--on-bad",
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
      ({ theme, tokens }) => {
        document.documentElement.dataset.theme = theme
        const { documentTokenReader, resolveCssColor } = (
          globalThis as typeof globalThis & {
            PigcodeColors: typeof import("../../../packages/ui-primitives/src/theme/resolve-color")
          }
        ).PigcodeColors
        const read = documentTokenReader()
        return Object.entries(tokens).map(([name, token]) => {
          const hex = resolveCssColor(read(token))?.slice(1).toUpperCase()
          if (!hex) throw new Error("无法解析颜色 " + token)
          return [name, hex.length === 8 ? hex.slice(6) + hex.slice(0, 6) : "FF" + hex]
        })
      },
      { theme, tokens },
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
