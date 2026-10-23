/**
 * 语法高亮：Shiki 的 JavaScript 正则引擎（不用 WASM），语言按需加载并各自分包。
 * 浅色与深色两套颜色写在 token 的 CSS 变量里，由样式按应用主题选用，切换主题不必重新高亮。
 */
import type { HighlighterCore } from "shiki/core"

/** 一个高亮片段：文字与带 `--shiki-light` / `--shiki-dark` 变量的样式。 */
export interface HighlightToken {
  content: string
  style?: Record<string, string> | undefined
}

/** 支持的语言与加载方式；每个 import 单独打包，打开对应文件时才下载。 */
const LANGUAGES: Record<string, () => Promise<unknown>> = {
  astro: () => import("shiki/langs/astro.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  make: () => import("shiki/langs/make.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  proto: () => import("shiki/langs/proto.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  scala: () => import("shiki/langs/scala.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  zig: () => import("shiki/langs/zig.mjs"),
}

/** 扩展名到语言。 */
const EXTENSIONS: Record<string, string> = {
  astro: "astro",
  bash: "shellscript",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cts: "typescript",
  cxx: "cpp",
  dart: "dart",
  diff: "diff",
  ex: "elixir",
  exs: "elixir",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  h: "c",
  hpp: "cpp",
  htm: "html",
  html: "html",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  json5: "jsonc",
  jsonc: "jsonc",
  jsx: "jsx",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  lua: "lua",
  md: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  mts: "typescript",
  patch: "diff",
  php: "php",
  proto: "proto",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scala: "scala",
  scss: "scss",
  sh: "shellscript",
  sql: "sql",
  svelte: "svelte",
  svg: "xml",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zig: "zig",
  zsh: "shellscript",
}

/** 没有扩展名或扩展名不说明类型的常见文件名。 */
const FILE_NAMES: Record<string, string> = {
  ".bashrc": "shellscript",
  ".editorconfig": "ini",
  ".env": "ini",
  ".gitattributes": "ini",
  ".gitconfig": "ini",
  ".npmrc": "ini",
  ".zshrc": "shellscript",
  "cmakelists.txt": "make",
  dockerfile: "docker",
  gemfile: "ruby",
  makefile: "make",
  "tsconfig.json": "jsonc",
}

/** 文件对应的高亮语言；不认识的返回 null，按纯文本显示。 */
export function languageForPath(path: string): string | null {
  const name = (path.split("/").at(-1) ?? path).toLowerCase()
  const byName = FILE_NAMES[name] ?? (name.startsWith(".env.") ? "ini" : undefined)
  if (byName) return byName
  if (name.startsWith("dockerfile")) return "docker"
  const dot = name.lastIndexOf(".")
  return dot > 0 ? (EXTENSIONS[name.slice(dot + 1)] ?? null) : null
}

/** 代码围栏里常见的语言别名。 */
const FENCE_ALIASES: Record<string, string> = {
  console: "shellscript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  ts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  shellsession: "shellscript",
  yml: "yaml",
  md: "markdown",
  dockerfile: "docker",
  ps: "powershell",
  ps1: "powershell",
  "c++": "cpp",
  cs: "csharp",
  kt: "kotlin",
  golang: "go",
  patch: "diff",
}

/** Markdown 代码围栏的语言名对应的高亮语言；不认识的返回 null。 */
export function languageForFence(lang: string): string | null {
  const name = lang.trim().toLowerCase()
  if (!name) return null
  const language = FENCE_ALIASES[name] ?? name
  return language in LANGUAGES ? language : null
}

let highlighter: Promise<HighlighterCore> | null = null

/** 第一次高亮时才创建 Shiki；主题只有浅色与深色两套。 */
function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ])
    return createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
      langs: [],
    })
  })()
  return highlighter
}

/** 把代码切成按行的高亮片段；语言不支持或加载失败时返回 null。 */
export async function highlightLines(
  code: string,
  language: string,
): Promise<HighlightToken[][] | null> {
  const load = LANGUAGES[language]
  if (!load) return null
  try {
    const instance = await getHighlighter()
    if (!instance.getLoadedLanguages().includes(language)) {
      await instance.loadLanguage(load() as Parameters<HighlighterCore["loadLanguage"]>[0])
    }
    const { tokens } = instance.codeToTokens(code, {
      lang: language,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    })
    return tokens.map((line) =>
      line.map((token) => ({ content: token.content, style: token.htmlStyle })),
    )
  } catch {
    return null
  }
}
