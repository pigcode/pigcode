/**
 * 命名检查（见聚合仓库的 GLOSSARY.md）：Agent 不叫 provider，Agent 功能不叫 capability / capabilities；
 * capability 只指 Capability 插件这一种插件。扫描 git 里的源码与文档，列出每一处 `文件:行` 和命中的词。
 *
 * 例外只有三类，每条写明原因：迁移旧数据的代码与测试（按文件），拒绝旧写法的报错与测试（按代码段），
 * 同一个词的其他含义（按模式，命中的词必须整个落在模式匹配到的范围里）。
 * provide / provides 是另一个词，不含 provider，本来就不会命中。
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/** frontend 目录。 */
const root = fileURLToPath(new URL("..", import.meta.url))

/** 旧名字：provider（指 Agent）与 capability / capabilities（指 Agent 功能），包括拼进标识符的写法。 */
const OLD_NAME = /\w*(?:provider|capabilit(?:y|ies))\w*/gi

/** 这些目录下的源码要扫；另外还有 .github/、docs/ 与所有 README.md。 */
const SOURCE_DIRS = ["packages/", "apps/", "scripts/", "examples/"]
const SOURCE_FILE = /\.(?:ts|tsx|js|mjs|json|css|ya?ml)$/

function inScope(file: string): boolean {
  if (file.startsWith(".github/") || file.startsWith("docs/")) return true
  if (file === "README.md" || file.endsWith("/README.md")) return true
  return SOURCE_DIRS.some((dir) => file.startsWith(dir)) && SOURCE_FILE.test(file)
}

/** 整个文件不扫：本检查自己的规则与样例，以及外部配置格式里同名的键。 */
const EXEMPT_FILES: ReadonlyArray<{ file: RegExp; reason: string }> = [
  {
    file: /^scripts\/naming-scan\.test\.ts$/,
    reason: "本检查自己：规则与测试样例里写着旧名字",
  },
  {
    file: /^apps\/desktop\/electron-builder\.yml$/,
    reason:
      "electron-builder 的 publish 配置键就叫 provider（GitHub 更新源），是外部配置格式，不是产品术语",
  },
]

/** 文件里的一段不扫：从含 start 的行到含 end 的行之前。旧写法要被拒绝，报错和测试只能写出旧名字。 */
const EXEMPT_SECTIONS: ReadonlyArray<{ file: string; start: string; end: string; reason: string }> =
  [
    {
      file: "packages/plugin-sdk/src/manifest.ts",
      start: "Agent 插件改名前的写法",
      end: ".refine((value) => Boolean(value.pigcode.host || value.pigcode.client)",
      reason: "manifest 里改名前的写法给出可照着改的报错",
    },
    {
      file: "packages/plugin-sdk/src/manifest.test.ts",
      start: 'describe("the old provider names in the manifest"',
      end: 'describe("plugin compatibility"',
      reason: "改名前的 manifest 写法被拒绝的测试",
    },
    {
      file: "apps/host/src/services/plugin-builtin.test.ts",
      start: 'it("lists an installed plugin still written with kind provider as failed',
      end: 'it("keeps the default agent when another plugin is uninstalled',
      reason: "装好的旧插件显示为失败、仍可卸载的测试",
    },
    {
      file: "apps/host/src/rpc/agent-options.test.ts",
      start: 'it("rejects the old provider.* and thread.switchProvider names',
      end: 'it("keeps agent.list as the settings list',
      reason: "改名前的 RPC 命令名被拒绝的测试",
    },
    {
      file: "docs/plugin-authoring.md",
      start: "### 从 provider 迁移",
      end: "## Capability 插件",
      reason: "写给插件作者的迁移说明：旧写法对应的新写法",
    },
  ]

/** 同一个词的其他含义。file 缺省表示所有文件；模式带 g，按命中范围判断。 */
const ALLOWED_PATTERNS: ReadonlyArray<{ pattern: RegExp; file?: string; reason: string }> = [
  ...[
    "packages/agent-codex/src/driver.ts",
    "packages/agent-codex/src/driver.test.ts",
    "packages/agent-codex/src/permissions.test.ts",
  ].map((file) => ({
    file,
    pattern: /\bcapabilities: \{ experimentalApi: true \}/g,
    reason:
      "Codex app-server initialize 的原生协议字段，用于启用计划和提问，不是 Pigcode 的 Agent 功能命名",
  })),
  {
    pattern: /\b(?:LocaleProvider|ToastProvider)\b/g,
    reason: "React context 的 Provider 组件，只认这两个已有的名字",
  },
  {
    pattern: /\b[A-Z]\w*\.Provider\b/g,
    reason: "React 的 X.Provider 写法（Tooltip.Provider、LocaleContext.Provider 等）",
  },
  {
    pattern: /\bProvider: BaseTooltip\.Provider\b/g,
    file: "packages/ui-primitives/src/components/tooltip.tsx",
    reason: "Tooltip 命名空间里定义 Tooltip.Provider 的那一项",
  },
  {
    pattern: /\bcapabilities: \{ tools\b/g,
    file: "apps/host/src/mcp/stdio-bridge.ts",
    reason: "MCP 协议 initialize 结果里的 capabilities",
  },
  { pattern: /\bCapability\b/g, reason: "Capability 插件这一种类的名字与英文标签" },
  { pattern: /(["'`])capability\1/g, reason: "kind 的取值 capability" },
  { pattern: /\bplugins\.kind\.capability\b/g, reason: "语言包里 Capability 种类标签的键" },
  {
    pattern: /\bcapability: "plugins\.kind\.capability"/g,
    file: "packages/ui-plugin-manager/src/plugin-summary.ts",
    reason: "插件种类到标签键的映射，键是 kind 的取值",
  },
  { pattern: /\bcapability\.(?=[\w@])/g, reason: "Capability 插件的 id：capability.<包名>" },
  { pattern: /\bcapability-/g, reason: "Capability 样例与包名：capability-<名字>" },
  {
    pattern: /\bagent \| capability \| ui\b/g,
    file: "scripts/create-plugin.ts",
    reason: "脚手架用法说明里的 kind 列表",
  },
  {
    pattern: /\b(?:capabilityEntry|capabilityItem|capabilityPlugin|installCapabilitySample)\b/g,
    reason: "指 Capability 插件的标识符：脚手架的入口模板、E2E 与样例测试里的变量",
  },
  {
    pattern: /toContain\("provider: github"\)/g,
    file: "apps/desktop/e2e/packaged.spec.ts",
    reason:
      "检查安装包里的 app-update.yml；键名和 electron-builder.yml 的 publish 配置是同一个外部格式，不是产品术语",
  },
]

interface Finding {
  file: string
  line: number
  text: string
  source: string
}

/** 一行里不在任何例外模式范围内的旧名字。 */
function oldNamesInLine(file: string, line: string): string[] {
  const allowed: Array<[number, number]> = []
  for (const rule of ALLOWED_PATTERNS) {
    if (rule.file && rule.file !== file) continue
    for (const match of line.matchAll(rule.pattern)) {
      allowed.push([match.index, match.index + match[0].length])
    }
  }
  const found: string[] = []
  for (const match of line.matchAll(OLD_NAME)) {
    const start = match.index
    const end = start + match[0].length
    if (!allowed.some(([from, to]) => from <= start && end <= to)) found.push(match[0])
  }
  return found
}

/** 文件里按代码段例外的行号（从 1 开始）；找不到起止标记时报错，避免例外悄悄失效。 */
function exemptLines(file: string, lines: readonly string[]): Set<number> {
  const exempt = new Set<number>()
  for (const section of EXEMPT_SECTIONS) {
    if (section.file !== file) continue
    const start = lines.findIndex((line) => line.includes(section.start))
    const end = lines.findIndex((line, index) => index > start && line.includes(section.end))
    if (start === -1 || end === -1) {
      throw new Error(`naming-scan: section markers not found in ${file}: ${section.start}`)
    }
    for (let index = start; index < end; index += 1) exempt.add(index + 1)
  }
  return exempt
}

function findingsIn(file: string, text: string): Finding[] {
  const lines = text.split(/\r?\n/)
  const exempt = exemptLines(file, lines)
  return lines.flatMap((source, index) =>
    exempt.has(index + 1)
      ? []
      : oldNamesInLine(file, source).map((name) => ({
          file,
          line: index + 1,
          text: name,
          source: source.trim(),
        })),
  )
}

/** git 管理的文件（含尚未提交、未被忽略的新文件）；生成物和被忽略的文件不在里面。 */
function trackedFiles(): string[] {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      encoding: "utf8",
    },
  )
  return [...new Set(output.split("\0").filter(Boolean))].sort()
}

describe("naming rules", () => {
  it("finds provider for an Agent and capabilities for Agent features", () => {
    const source = [
      "const providerId = thread.providerId",
      "const driver = { capabilities: { plan: true } }",
      "env.PIGCODE_PROVIDER",
      "/** the agent capability flags */",
    ].join("\n")
    expect(findingsIn("packages/ui-chat/src/x.tsx", source).map((found) => found.text)).toEqual([
      "providerId",
      "providerId",
      "capabilities",
      "PIGCODE_PROVIDER",
      "capability",
    ])
  })

  it("allows the other meanings only in their narrow forms", () => {
    const allowed = [
      "<LocaleProvider locale={locale}><Tooltip.Provider>",
      "<ConversationActionsContext.Provider value={actions}>",
      'kind: "capability", ["agent", "capability", "ui"]',
      "Capability 插件 / Capability plugins",
      '"plugins.kind.capability": "Capability"',
      "capability.pigcode-capability-clock examples/capability-session-info",
      "ctx.provide(name) provides: []",
    ].join("\n")
    expect(findingsIn("packages/ui-shell/src/x.tsx", allowed)).toEqual([])

    const rejected = [
      "<SessionProvider>",
      "capabilities: { tools: {} }",
      "the capability sample",
      "agent | capability | ui",
    ].join("\n")
    expect(findingsIn("packages/ui-shell/src/x.tsx", rejected).map((found) => found.text)).toEqual([
      "SessionProvider",
      "capabilities",
      "capability",
      "capability",
    ])
    expect(findingsIn("apps/host/src/mcp/stdio-bridge.ts", "capabilities: { tools: {} }")).toEqual(
      [],
    )
  })

  it("skips only the marked sections of a file", () => {
    const file = "docs/plugin-authoring.md"
    const text = [
      "providerId",
      "### 从 provider 迁移",
      "provider",
      "## Capability 插件",
      "provider",
    ]
    expect(findingsIn(file, text.join("\n")).map((found) => found.line)).toEqual([1, 5])
    expect(() => findingsIn(file, "provider")).toThrow("section markers not found")
  })
})

describe("naming scan", () => {
  const files = trackedFiles()

  it("keeps every exemption pointing at a file that exists", () => {
    for (const rule of EXEMPT_FILES) {
      expect(
        files.some((file) => rule.file.test(file)),
        String(rule.file),
      ).toBe(true)
    }
    for (const section of EXEMPT_SECTIONS) expect(files, section.file).toContain(section.file)
  })

  it("does not use provider for an Agent or capability for an Agent feature", () => {
    const findings = files
      .filter((file) => inScope(file) && !EXEMPT_FILES.some((rule) => rule.file.test(file)))
      .filter((file) => existsSync(join(root, file)))
      .flatMap((file) => findingsIn(file, readFileSync(join(root, file), "utf8")))
    const listed = findings
      .map((found) => `  ${found.file}:${found.line}  ${found.text}  |  ${found.source}`)
      .join("\n")
    expect(
      findings,
      `用了旧名字的位置（Agent 不叫 provider，Agent 功能不叫 capability）：\n${listed}`,
    ).toEqual([])
  })
})
