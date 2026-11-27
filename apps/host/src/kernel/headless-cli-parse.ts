/** `pigcode-host` 命令行参数解析、校验与帮助文本生成。 */

export interface GlobalCliOptions {
  profileDir?: string | undefined
  profileName: string
  json: boolean
  help: boolean
}

export type ParsedCliCommand =
  | { kind: "help" }
  | { kind: "dump-config" }
  | { kind: "start"; lanPort: number | false | undefined; noShellEnv: boolean }
  | { kind: "status" }
  | { kind: "relay-status" }
  | { kind: "relay-set"; address: string; token?: string | undefined; tokenStdin: boolean }
  | { kind: "relay-clear" }
  | { kind: "pair"; showRaw: boolean }
  | { kind: "devices" }
  | { kind: "revoke"; idOrPrefix: string; yes: boolean }

export type ParseCliResult =
  { ok: true; global: GlobalCliOptions; command: ParsedCliCommand } | { ok: false; error: string }

const VALUE_FLAGS = new Set(["--profile-dir", "--profile", "--lan-port", "--address", "--token"])
const BOOLEAN_FLAGS = new Set([
  "--json",
  "-h",
  "--help",
  "--dump-config",
  "--no-shell-env",
  "--token-stdin",
  "--show-raw",
  "--yes",
  "-y",
])

/** 校验并解析 `--lan-port`：支持 `off`/`false` 或 `0..65535` 整数端口。 */
export function parseLanPort(raw: string): number | false | null {
  const normalized = raw.trim().toLowerCase()
  if (normalized === "off" || normalized === "false") return false
  if (!/^\d+$/.test(normalized)) return null
  const port = Number(normalized)
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null
}

/** 返回 CLI 使用说明。 */
export function formatHelpText(): string {
  return [
    "用法: pigcode-host [全局选项] <子命令>",
    "",
    "子命令:",
    "  start [--lan-port <端口|off>] [--no-shell-env]  启动无窗口常驻 Host 服务",
    "  status                                          查看 Host 运行状态与配对摘要",
    "  relay status                                    查看中继配置状态",
    "  relay set --address <wss://...> [--token <t> | --token-stdin]  测试并保存中继配置",
    "  relay clear                                     清除已保存的中继配置",
    "  pair [--show-raw]                               在终端生成二维码并完成手机端配对",
    "  devices                                         列出已配对设备",
    "  revoke <设备编号或名称> [--yes]                 撤销指定设备的配对",
    "  --dump-config                                   输出已解析的 profile 插件配置 JSON",
    "",
    "全局选项:",
    "  --profile-dir <dir>   指定用户配置目录（覆盖 PIGCODE_PROFILE_DIR）",
    "  --profile <name>      指定 profile 名称（不含 .yml，默认 desktop）",
    "  --json                输出结构化 JSON / NDJSON",
    "  -h, --help            显示此帮助信息",
  ].join("\n")
}

interface RawScanState {
  global: GlobalCliOptions
  dumpConfig: boolean
  lanPortRaw?: string | undefined
  noShellEnv: boolean
  address?: string | undefined
  token?: string | undefined
  tokenStdin: boolean
  showRaw: boolean
  yes: boolean
  seenFlags: Set<string>
  positionals: string[]
}

function takeFlagValue(
  argv: string[],
  index: number,
  flagName: string,
  inlineValue: string | undefined,
  allowLeadingDash: boolean,
): { ok: true; value: string; nextIndex: number } | { ok: false; error: string } {
  if (inlineValue !== undefined) {
    if (inlineValue === "") return { ok: false, error: `参数 ${flagName} 缺少取值` }
    return { ok: true, value: inlineValue, nextIndex: index }
  }
  const next = argv[index + 1]
  if (
    next === undefined ||
    next === "" ||
    (allowLeadingDash
      ? VALUE_FLAGS.has(next) || BOOLEAN_FLAGS.has(next)
      : next.startsWith("-") && !(flagName === "--lan-port" && /^-\d+$/.test(next)))
  ) {
    return { ok: false, error: `参数 ${flagName} 缺少取值` }
  }
  return { ok: true, value: next, nextIndex: index + 1 }
}

function validateAllowedFlags(
  seenFlags: ReadonlySet<string>,
  allowed: ReadonlyArray<string>,
  commandLabel: string,
): string | null {
  const allowSet = new Set(allowed)
  for (const flag of seenFlags) {
    if (!allowSet.has(flag)) {
      return `子命令 ${commandLabel} 不支持选项 ${flag}`
    }
  }
  return null
}

/** 解析 `pigcode-host` 命令行参数；支持全局选项出现在子命令前后。 */
export function parseHeadlessCliArgs(argv: string[]): ParseCliResult {
  const state: RawScanState = {
    global: { profileName: "desktop", json: false, help: false },
    dumpConfig: false,
    noShellEnv: false,
    tokenStdin: false,
    showRaw: false,
    yes: false,
    seenFlags: new Set(),
    positionals: [],
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (!arg.startsWith("-") || arg === "-") {
      state.positionals.push(arg)
      continue
    }

    const eqIndex = arg.indexOf("=")
    const flagName = eqIndex >= 0 ? arg.slice(0, eqIndex) : arg
    const inlineValue = eqIndex >= 0 ? arg.slice(eqIndex + 1) : undefined

    if (BOOLEAN_FLAGS.has(flagName)) {
      if (inlineValue !== undefined) {
        return { ok: false, error: `开关选项 ${flagName} 不接受取值` }
      }
      if (flagName === "--json") state.global.json = true
      else if (flagName === "-h" || flagName === "--help") state.global.help = true
      else if (flagName === "--dump-config") state.dumpConfig = true
      else {
        const canonical = flagName === "-y" ? "--yes" : flagName
        state.seenFlags.add(canonical)
        if (canonical === "--no-shell-env") state.noShellEnv = true
        else if (canonical === "--token-stdin") state.tokenStdin = true
        else if (canonical === "--show-raw") state.showRaw = true
        else if (canonical === "--yes") state.yes = true
      }
      continue
    }

    if (VALUE_FLAGS.has(flagName)) {
      const taken = takeFlagValue(argv, i, flagName, inlineValue, flagName === "--token")
      if (!taken.ok) return taken
      i = taken.nextIndex
      if (flagName === "--profile-dir") state.global.profileDir = taken.value
      else if (flagName === "--profile") state.global.profileName = taken.value
      else {
        state.seenFlags.add(flagName)
        if (flagName === "--lan-port") state.lanPortRaw = taken.value
        else if (flagName === "--address") state.address = taken.value
        else if (flagName === "--token") state.token = taken.value
      }
      continue
    }

    return { ok: false, error: `未知选项: ${flagName}` }
  }

  if (state.global.help) {
    return { ok: true, global: state.global, command: { kind: "help" } }
  }

  if (state.dumpConfig) {
    if (state.positionals.length > 0) {
      return { ok: false, error: "--dump-config 不能与子命令同时使用" }
    }
    const invalid = validateAllowedFlags(state.seenFlags, [], "--dump-config")
    if (invalid) return { ok: false, error: invalid }
    return { ok: true, global: state.global, command: { kind: "dump-config" } }
  }

  const [cmd, sub, ...rest] = state.positionals
  if (!cmd) {
    return {
      ok: false,
      error: "缺少子命令；可用命令: start, status, relay, pair, devices, revoke 或 --dump-config",
    }
  }

  if (cmd === "start") {
    if (sub !== undefined) return { ok: false, error: `start 不接受多余参数: ${sub}` }
    const invalid = validateAllowedFlags(state.seenFlags, ["--lan-port", "--no-shell-env"], "start")
    if (invalid) return { ok: false, error: invalid }
    let lanPort: number | false | undefined
    if (state.lanPortRaw !== undefined) {
      const parsed = parseLanPort(state.lanPortRaw)
      if (parsed === null) {
        return {
          ok: false,
          error: `无效的 --lan-port 参数 "${state.lanPortRaw}"，应为 0-65535 的整数或 off`,
        }
      }
      lanPort = parsed
    }
    return {
      ok: true,
      global: state.global,
      command: { kind: "start", lanPort, noShellEnv: state.noShellEnv },
    }
  }

  if (cmd === "status") {
    if (sub !== undefined) return { ok: false, error: `status 不接受多余参数: ${sub}` }
    const invalid = validateAllowedFlags(state.seenFlags, [], "status")
    if (invalid) return { ok: false, error: invalid }
    return { ok: true, global: state.global, command: { kind: "status" } }
  }

  if (cmd === "relay") {
    if (!sub) return { ok: false, error: "relay 需要子操作: status | set | clear" }
    if (rest.length > 0) return { ok: false, error: `relay ${sub} 不接受多余参数: ${rest[0]}` }
    if (sub === "status") {
      const invalid = validateAllowedFlags(state.seenFlags, [], "relay status")
      if (invalid) return { ok: false, error: invalid }
      return { ok: true, global: state.global, command: { kind: "relay-status" } }
    }
    if (sub === "clear") {
      const invalid = validateAllowedFlags(state.seenFlags, [], "relay clear")
      if (invalid) return { ok: false, error: invalid }
      return { ok: true, global: state.global, command: { kind: "relay-clear" } }
    }
    if (sub === "set") {
      const invalid = validateAllowedFlags(
        state.seenFlags,
        ["--address", "--token", "--token-stdin"],
        "relay set",
      )
      if (invalid) return { ok: false, error: invalid }
      if (!state.address?.trim()) {
        return { ok: false, error: "relay set 必须提供 --address <wss://...>" }
      }
      if (state.token !== undefined && state.tokenStdin) {
        return { ok: false, error: "--token 与 --token-stdin 不能同时使用" }
      }
      return {
        ok: true,
        global: state.global,
        command: {
          kind: "relay-set",
          address: state.address,
          token: state.token,
          tokenStdin: state.tokenStdin,
        },
      }
    }
    return { ok: false, error: `未知的 relay 子操作: ${sub}` }
  }

  if (cmd === "pair") {
    if (sub !== undefined) return { ok: false, error: `pair 不接受多余参数: ${sub}` }
    const invalid = validateAllowedFlags(state.seenFlags, ["--show-raw"], "pair")
    if (invalid) return { ok: false, error: invalid }
    return { ok: true, global: state.global, command: { kind: "pair", showRaw: state.showRaw } }
  }

  if (cmd === "devices") {
    if (sub !== undefined) return { ok: false, error: `devices 不接受多余参数: ${sub}` }
    const invalid = validateAllowedFlags(state.seenFlags, [], "devices")
    if (invalid) return { ok: false, error: invalid }
    return { ok: true, global: state.global, command: { kind: "devices" } }
  }

  if (cmd === "revoke") {
    if (!sub?.trim()) return { ok: false, error: "revoke 需要指定设备编号、前缀或名称" }
    if (rest.length > 0) return { ok: false, error: `revoke 不接受多余参数: ${rest[0]}` }
    const invalid = validateAllowedFlags(state.seenFlags, ["--yes"], "revoke")
    if (invalid) return { ok: false, error: invalid }
    return {
      ok: true,
      global: state.global,
      command: { kind: "revoke", idOrPrefix: sub, yes: state.yes },
    }
  }

  return { ok: false, error: `未知子命令: ${cmd}` }
}
