/** 根据实际安装目录选择包管理器，更新目标由插件的包名限定。 */
import { dirname, join } from "node:path"

export interface CliUpdateSource {
  manager: "npm" | "bun" | "pnpm" | "brew" | "native"
  directory: string
  args: string[]
  versionUrl: string
  versionFormat: "npm" | "brew-cask" | "brew-formula" | "text"
}

export function resolveCliUpdateSource(input: {
  executable: string
  realExecutable: string
  packageName: string
  brewFormula?: string | undefined
  native?: { matches: (path: string) => boolean; args: string[]; versionUrl: string } | undefined
}): CliUpdateSource | null {
  const real = input.realExecutable.replaceAll("\\", "/")
  const original = input.executable.replaceAll("\\", "/")
  const npmUrl = `https://registry.npmjs.org/${encodeURIComponent(input.packageName)}/latest`
  const brew = real.match(/^(.*)\/(Caskroom|Cellar)\/([^/]+)\//i)
  if (
    brew &&
    input.brewFormula &&
    [input.brewFormula, `${input.brewFormula}@latest`].includes(brew[3]!)
  ) {
    const cask = brew[2]?.toLowerCase() === "caskroom"
    return {
      manager: "brew",
      directory: join(brew[1]!, "bin"),
      args: ["upgrade", cask ? "--cask" : "--formula", brew[3]!],
      versionUrl: `https://formulae.brew.sh/api/${cask ? "cask" : "formula"}/${encodeURIComponent(brew[3]!)}.json`,
      versionFormat: cask ? "brew-cask" : "brew-formula",
    }
  }
  if (input.native?.matches(real)) {
    return {
      manager: "native",
      directory: dirname(input.executable),
      args: input.native.args,
      versionUrl: input.native.versionUrl,
      versionFormat: "text",
    }
  }
  const packageMarker = `/node_modules/${input.packageName}/`
  const at = real.lastIndexOf(packageMarker)
  if (at < 0) return null
  const install = real.slice(0, at)
  const bun = install.match(/^(.*)\/install\/global$/)
  if (bun && dirname(original).replaceAll("\\", "/") === `${bun[1]}/bin`) {
    return {
      manager: "bun",
      directory: join(bun[1]!, "bin"),
      args: ["add", "--global", `${input.packageName}@latest`],
      versionUrl: npmUrl,
      versionFormat: "npm",
    }
  }
  const pnpm = real.match(/^(.*)\/global\/(\d+)\//)
  if (pnpm && /pnpm/i.test(pnpm[1]!)) {
    return {
      manager: "pnpm",
      directory: pnpm[1]!,
      args: [
        "add",
        "--global",
        "--global-dir",
        `${pnpm[1]}/global/${pnpm[2]}`,
        "--global-bin-dir",
        pnpm[1]!,
        `${input.packageName}@latest`,
      ],
      versionUrl: npmUrl,
      versionFormat: "npm",
    }
  }
  const prefix = install.endsWith("/lib") ? install.slice(0, -4) : install
  const bin = install.endsWith("/lib") ? `${prefix}/bin` : prefix
  // 项目里的 node_modules/.bin 属于项目依赖，不能当作全局 CLI 更新。
  if (dirname(original).replaceAll("\\", "/") !== bin) return null
  return {
    manager: "npm",
    directory: bin,
    args: ["install", "--global", "--prefix", prefix, `${input.packageName}@latest`],
    versionUrl: npmUrl,
    versionFormat: "npm",
  }
}
