/**
 * 从 build/icon.svg 生成三个平台的应用图标。
 *
 * 只有 SVG 是源文件；icns、ico、png 都是派生产物，改了形状要重新跑一次：
 *
 *     node ../../scripts/build-icons.ts
 *
 * macOS 用系统自带的 sips + iconutil，Windows 的 ico 直接按 PE 的图标容器格式写
 * （Vista 起允许每帧嵌 PNG，不必转 BMP）。Linux 用 1024×1024 的 png。
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const buildDir = fileURLToPath(new URL("../apps/desktop/build/", import.meta.url))
const source = join(buildDir, "icon.svg")
const work = mkdtempSync(join(tmpdir(), "pigcode-icons-"))

/** sips 把一个 PNG 缩放到指定边长。 */
function resize(from: string, to: string, size: number): void {
  execFileSync("sips", ["-z", String(size), String(size), from, "--out", to], {
    stdio: "ignore",
  })
}

/** SVG 转 PNG；sips 直接支持。 */
function rasterize(svg: string, png: string): void {
  execFileSync("sips", ["-s", "format", "png", svg, "--out", png], { stdio: "ignore" })
}

/**
 * 按 ICO 容器格式打包若干 PNG：6 字节头 + 每张 16 字节目录项 + 图像数据。
 * 256 在字段里记作 0，这是这个格式的规定。
 */
function buildIco(pngs: Array<{ size: number; data: Buffer }>): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const directory: Buffer[] = []
  let offset = 6 + pngs.length * 16
  for (const png of pngs) {
    const entry = Buffer.alloc(16)
    const dimension = png.size >= 256 ? 0 : png.size
    entry.writeUInt8(dimension, 0)
    entry.writeUInt8(dimension, 1)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(png.data.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += png.data.length
    directory.push(entry)
  }
  return Buffer.concat([header, ...directory, ...pngs.map((png) => png.data)])
}

function main(): void {
  const base = join(work, "icon.png")
  rasterize(source, base)
  writeFileSync(join(buildDir, "icon.png"), readFileSync(base))

  // macOS：iconset 里每个尺寸都要有 1x 和 2x 两个文件，iconutil 才认。
  const iconset = join(work, "Pigcode.iconset")
  execFileSync("mkdir", ["-p", iconset])
  for (const size of [16, 32, 128, 256, 512]) {
    resize(base, join(iconset, `icon_${String(size)}x${String(size)}.png`), size)
    resize(base, join(iconset, `icon_${String(size)}x${String(size)}@2x.png`), size * 2)
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(buildDir, "icon.icns")])

  // Windows：从 16 到 256 各来一张，任务栏和资源管理器都会用到。
  const frames = [16, 24, 32, 48, 64, 128, 256].map((size) => {
    const path = join(work, `ico_${String(size)}.png`)
    resize(base, path, size)
    return { size, data: readFileSync(path) }
  })
  writeFileSync(join(buildDir, "icon.ico"), buildIco(frames))

  // 菜单栏图标：模板图，只有 alpha，颜色由系统按明暗主题决定。
  // 16px 下细节会糊，所以 build/tray/tray.svg 是单独画的简化版，不是主图标的缩小。
  const traySource = join(buildDir, "tray", "tray.svg")
  if (existsSync(traySource)) {
    const trayBase = join(work, "tray.png")
    rasterize(traySource, trayBase)
    resize(trayBase, join(buildDir, "tray", "trayTemplate.png"), 16)
    resize(trayBase, join(buildDir, "tray", "trayTemplate@2x.png"), 32)
    console.log("tray: build/tray/trayTemplate.png (+@2x)")
  }

  console.log("icons: build/icon.icns, build/icon.ico, build/icon.png")
}

try {
  main()
} finally {
  rmSync(work, { recursive: true, force: true })
}
