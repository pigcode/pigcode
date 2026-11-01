/**
 * 样式检查：统计主题 token 以外写死的颜色，写死的圆角、字号、控件高度，tokens.css 以外声明的尺寸变量，
 * 重复定义的选择器，以及组件里写死的界面文字。各类数量记在 style-check.baseline.json，只能减少。
 * HARD_RULES 里的类别是硬性规则：不看基线，出现一处就失败。目前每一类都是硬性规则。
 *
 *   node scripts/style-check.ts            # 打印各类数量；违反硬性规则时退出码为 1
 *   node scripts/style-check.ts --update   # 把当前数量写成新的基线；任何一类变多时拒绝
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

export const CATEGORIES = [
  "color",
  "radius",
  "fontSize",
  "height",
  "customProperty",
  "duplicateSelector",
  "uiText",
] as const

export type Category = (typeof CATEGORIES)[number]

/**
 * 硬性规则：上限固定为 0，不受基线影响。颜色和尺寸一律取 tokens.css 的 token，界面文字一律放进语言包。
 */
export const HARD_RULES: readonly Category[] = [
  "color",
  "radius",
  "fontSize",
  "height",
  "customProperty",
  "duplicateSelector",
  "uiText",
]

/** 一类问题允许的数量：硬性规则是 0，其余按基线。 */
export function ceilingOf(category: Category, baseline: Baseline): number {
  return HARD_RULES.includes(category) ? 0 : baseline[category].total
}

/** 一处问题：文件路径相对 frontend 目录，统一用 `/` 分隔。 */
export interface Finding {
  file: string
  line: number
  text: string
}

export type Report = Record<Category, Finding[]>

/** 基线：每一类的总数和按文件的数量。 */
export type Baseline = Record<Category, { total: number; files: Record<string, number> }>

/** 各类的说明，用在输出里。 */
export const CATEGORY_LABELS: Record<Category, string> = {
  color: "主题 token 以外写死的颜色",
  radius: "写死的圆角",
  fontSize: "写死的字号",
  height: "写死的控件高度（height、min-height）",
  customProperty: "tokens.css 以外声明的尺寸变量（值里有大于 1px 的 px）",
  duplicateSelector: "重复定义的选择器",
  uiText: "组件里写死的界面文字",
}

/**
 * 允许出现颜色字面量的文件：主题 token（含磨砂块）、内置主题表，以及颜色运算（纯黑纯白是运算的两端）。
 * 外观推导（appearance-*.ts）和终端配色都从 tokens.css 原文读色值，不在此列。
 */
const COLOR_SOURCES = new Set([
  "packages/ui-primitives/src/styles/tokens.css",
  "packages/ui-primitives/src/theme/theme-presets.ts",
  "packages/ui-primitives/src/theme/color-math.ts",
])

/** 定义尺寸 token 的文件，不算写死的尺寸，也只有这里可以声明带 px 的变量。 */
const SIZE_SOURCES = new Set(["packages/ui-primitives/src/styles/tokens.css"])

const SKIPPED_DIRS = new Set([
  "node_modules",
  "out",
  "dist",
  "coverage",
  "test-results",
  "playwright-report",
])

/** 参与检查的目录：各个包的源码和桌面端。 */
function sourceRoots(root: string): string[] {
  const packages = readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, "packages", entry.name, "src"))
  return [...packages, join(root, "apps/desktop/src")]
}

function listFiles(dir: string): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(path))
    else files.push(path)
  }
  return files
}

/** 测试、类型声明和语言包不算组件源码。 */
function isComponentSource(file: string): boolean {
  if (!/\.(ts|tsx)$/.test(file) || file.endsWith(".d.ts")) return false
  if (/\.test\.(ts|tsx)$/.test(file)) return false
  return !file.includes("/locale/")
}

// ---------- CSS ----------

/** CSS 里的一条样式规则；context 是外层的 @media、@container 和父选择器。 */
export interface CssRule {
  context: string
  selector: string
  line: number
}

export interface CssDeclaration {
  property: string
  value: string
  line: number
}

/** 去掉注释，保留换行，行号不变。 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
}

/** 选择器里的空白统一，组合符两边不留空格。 */
function normalizeSelector(selector: string): string {
  return selector
    .replace(/\s+/g, " ")
    .replace(/\s*([>+~,])\s*/g, "$1")
    .trim()
}

/** 拆出规则和声明；@keyframes 里的内容跳过。不支持的写法按普通文本处理，不抛错。 */
export function parseCss(css: string): { rules: CssRule[]; declarations: CssDeclaration[] } {
  const text = stripComments(css)
  const rules: CssRule[] = []
  const declarations: CssDeclaration[] = []
  const stack: Array<{ kind: "at" | "rule" | "skip"; prelude: string }> = []
  let segment = ""
  let segmentLine = 1
  let line = 1
  let quote: string | null = null
  let depth = 0

  const flushDeclaration = (): void => {
    const top = stack[stack.length - 1]
    const colon = segment.indexOf(":")
    if (top?.kind === "rule" && colon > 0) {
      declarations.push({
        property: segment.slice(0, colon).trim().toLowerCase(),
        value: segment.slice(colon + 1).trim(),
        line: segmentLine,
      })
    }
    segment = ""
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ""
    if (char === "\n") line += 1
    if (quote) {
      segment += char
      if (char === quote && text[index - 1] !== "\\") quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    if (char === "(") depth += 1
    if (char === ")") depth = Math.max(0, depth - 1)
    if (depth > 0 || (char !== "{" && char !== "}" && char !== ";")) {
      if (!segment.trim() && /\S/.test(char)) segmentLine = line
      segment += char
      continue
    }
    if (char === ";") {
      flushDeclaration()
      continue
    }
    if (char === "}") {
      flushDeclaration()
      stack.pop()
      continue
    }
    const prelude = segment.trim()
    segment = ""
    const parent = stack[stack.length - 1]
    if (parent?.kind === "skip" || /^@(-webkit-)?keyframes\b/.test(prelude)) {
      stack.push({ kind: "skip", prelude })
    } else if (prelude.startsWith("@")) {
      stack.push({ kind: "at", prelude: prelude.replace(/\s+/g, " ") })
    } else {
      const selector = normalizeSelector(prelude)
      const context = stack.map((block) => block.prelude).join(" | ")
      rules.push({ context, selector, line: segmentLine })
      stack.push({ kind: "rule", prelude: selector })
    }
  }
  return { rules, declarations }
}

/** 同一上下文里同一个选择器出现多次时，第一次以外的每一次都算一处重复。 */
export function duplicateSelectorFindings(file: string, rules: readonly CssRule[]): Finding[] {
  const seen = new Set<string>()
  const found: Finding[] = []
  for (const rule of rules) {
    const key = `${rule.context}\u0000${rule.selector}`
    if (seen.has(key)) found.push({ file, line: rule.line, text: rule.selector })
    else seen.add(key)
  }
  return found
}

const HEX_COLOR = /(?<![\w&-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|oklch|oklab|lch|lab)\(([^()]*)\)/g
const NAMED_COLOR = /(?<![\w-])(?:white|black)(?![\w-])/

/** 值里有颜色字面量：十六进制、参数里没有 var() 的颜色函数，或者 white、black。 */
export function hasColorLiteral(value: string): boolean {
  if (HEX_COLOR.test(value) || NAMED_COLOR.test(value)) return true
  for (const match of value.matchAll(COLOR_FUNCTION)) {
    if (!(match[1] ?? "").includes("var(")) return true
  }
  return false
}

/** 值里大于 1px 的 px 字面量（0、0.5px、1px 的细线不算）。 */
function hasPxLiteral(value: string): boolean {
  for (const match of value.matchAll(/(\d*\.?\d+)px\b/g)) {
    if (Number(match[1]) > 1) return true
  }
  return false
}

const RADIUS_PROPERTY = /^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$/

/** 一条声明属于哪一类写死的尺寸；不属于时返回 null。 */
export function sizeCategory(property: string, value: string): Category | null {
  if (RADIUS_PROPERTY.test(property)) return hasPxLiteral(value) ? "radius" : null
  if (property === "font-size") {
    if (hasPxLiteral(value) || /\d(?:rem)\b/.test(value)) return "fontSize"
    return /(\d*\.?\d+)em\b/.test(value) && !/^1em$/.test(value) ? "fontSize" : null
  }
  if (property === "height" || property === "min-height") {
    return hasPxLiteral(value) ? "height" : null
  }
  return null
}

/** 一个 CSS 文件里的问题，追加到 report。 */
export function cssFindings(file: string, css: string, report: Report): void {
  const { rules, declarations } = parseCss(css)
  report.duplicateSelector.push(...duplicateSelectorFindings(file, rules))
  for (const declaration of declarations) {
    const text = `${declaration.property}: ${declaration.value}`
    if (!COLOR_SOURCES.has(file) && hasColorLiteral(declaration.value)) {
      report.color.push({ file, line: declaration.line, text })
    }
    if (SIZE_SOURCES.has(file)) continue
    const size = sizeCategory(declaration.property, declaration.value)
    if (size) report[size].push({ file, line: declaration.line, text })
    // 自定义属性：把 `height: 26px` 改成局部的 `--x: 26px` 不算消掉了写死的尺寸
    if (declaration.property.startsWith("--") && hasPxLiteral(declaration.value)) {
      report.customProperty.push({ file, line: declaration.line, text })
    }
  }
}

// ---------- TypeScript ----------

const HAN = /\p{Script=Han}/u

interface StringPiece {
  text: string
  line: number
  node: ts.Node
}

/** 源码里的字符串、模板片段和 JSX 文本；注释不算。 */
function stringPieces(file: string, source: string): StringPiece[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
  const pieces: StringPiece[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      pieces.push({ text: node.text, line: line + 1, node })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return pieces
}

/** 含汉字的字符串和 JSX 文本：界面默认是中文，这是写死界面文字的可靠信号。 */
export function uiTextFindings(file: string, source: string): Finding[] {
  return stringPieces(file, source)
    .filter((piece) => HAN.test(piece.text))
    .map((piece) => ({ file, line: piece.line, text: piece.text.trim().slice(0, 60) }))
}

/** xterm 主题（ITheme）里 ANSI 16 色的键名；其中 black、white 也是 CSS 颜色名。 */
const XTERM_ANSI_KEYS = new Set([
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
])

/**
 * 字符串在当键名用，不是颜色：对象或类型的属性名、`x["…"]` 里的键、类型里的字面量；
 * 或者整串就是 xterm 的 ANSI 键名（如终端配色表里的 `["white", "--term-white"]`），
 * 又不是赋给属性、变量或 JSX 属性的值。
 */
function isKeyName(piece: StringPiece): boolean {
  const { node } = piece
  const parent = node.parent
  if (ts.isPropertyName(node) && "name" in parent && parent.name === node) return true
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true
  if (ts.isLiteralTypeNode(parent)) return true
  if (!XTERM_ANSI_KEYS.has(piece.text)) return false
  return !(
    ts.isPropertyAssignment(parent) ||
    ts.isVariableDeclaration(parent) ||
    ts.isJsxAttribute(parent)
  )
}

/** 字符串里的颜色字面量；当键名用的字符串不算。 */
export function tsColorFindings(file: string, source: string): Finding[] {
  return stringPieces(file, source)
    .filter((piece) => hasColorLiteral(piece.text) && !isKeyName(piece))
    .map((piece) => ({ file, line: piece.line, text: piece.text.trim().slice(0, 60) }))
}

// ---------- 汇总 ----------

export function emptyReport(): Report {
  return Object.fromEntries(CATEGORIES.map((category) => [category, []])) as unknown as Report
}

/** 扫描 frontend 目录，返回每一类的问题。 */
export function scanStyles(root: string): Report {
  const report = emptyReport()
  for (const dir of sourceRoots(root)) {
    for (const path of listFiles(dir)) {
      const file = relative(root, path).split(sep).join("/")
      if (file.endsWith(".css")) {
        cssFindings(file, readFileSync(path, "utf8"), report)
      } else if (isComponentSource(file)) {
        const source = readFileSync(path, "utf8")
        report.uiText.push(...uiTextFindings(file, source))
        if (!COLOR_SOURCES.has(file)) report.color.push(...tsColorFindings(file, source))
      }
    }
  }
  return report
}

/** 按文件计数，键按字母排序，基线文件的 diff 才稳定。 */
function countByFile(findings: readonly Finding[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const finding of findings) counts[finding.file] = (counts[finding.file] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

export function toBaseline(report: Report): Baseline {
  return Object.fromEntries(
    CATEGORIES.map((category) => [
      category,
      { total: report[category].length, files: countByFile(report[category]) },
    ]),
  ) as unknown as Baseline
}

const BASELINE_FILE = "scripts/style-check.baseline.json"

export function readBaseline(root: string): Baseline {
  return JSON.parse(readFileSync(join(root, BASELINE_FILE), "utf8")) as Baseline
}

/** 比基线多出来的文件和它们的问题；超过上限时用来指出新增的位置。硬性规则的每一处都算。 */
export function grownFindings(report: Report, baseline: Baseline, category: Category): Finding[] {
  if (HARD_RULES.includes(category)) return report[category]
  const before = baseline[category].files
  const now = countByFile(report[category])
  return report[category].filter(
    (finding) => (now[finding.file] ?? 0) > (before[finding.file] ?? 0),
  )
}

/** 每一类一行：当前数量 / 上限。 */
export function formatCounts(report: Report, baseline: Baseline | null): string {
  return CATEGORIES.map((category) => {
    const count = report[category].length
    const limit = baseline
      ? ceilingOf(category, baseline)
      : HARD_RULES.includes(category)
        ? 0
        : null
    const ceiling = limit === null ? "" : ` / 上限 ${limit}`
    return `${category.padEnd(18)} ${String(count).padStart(5)}${ceiling}  ${CATEGORY_LABELS[category]}`
  }).join("\n")
}

function main(): void {
  const root = fileURLToPath(new URL("..", import.meta.url))
  const report = scanStyles(root)
  let baseline: Baseline | null = null
  try {
    baseline = readBaseline(root)
  } catch {
    baseline = null
  }
  console.log(formatCounts(report, baseline))
  const broken = HARD_RULES.filter((category) => report[category].length > 0)
  if (broken.length > 0) {
    for (const category of broken) {
      console.error(`\n${CATEGORY_LABELS[category]}：`)
      for (const finding of report[category]) {
        console.error(`  ${finding.file}:${finding.line}  ${finding.text}`)
      }
    }
    console.error(`\n违反硬性规则：${broken.join("、")} 必须为 0。`)
    process.exit(1)
  }
  if (!process.argv.includes("--update")) return
  const grown = baseline
    ? CATEGORIES.filter((category) => report[category].length > ceilingOf(category, baseline))
    : []
  if (grown.length > 0) {
    console.error(`拒绝更新：${grown.join("、")} 比基线多。`)
    process.exit(1)
  }
  writeFileSync(join(root, BASELINE_FILE), `${JSON.stringify(toBaseline(report), null, 2)}\n`)
  console.log(`已写入 ${BASELINE_FILE}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
