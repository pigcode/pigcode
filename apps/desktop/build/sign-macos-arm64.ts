import { join } from "node:path"
import { signAsync } from "@electron/osx-sign"
import { Arch, log, type AfterPackContext } from "electron-builder"

export default async function signMacArm64(context: AfterPackContext): Promise<void> {
  if (context.electronPlatformName !== "darwin" || context.arch !== Arch.arm64) return

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  // Electron 的 arm64 原包只有 Mach-O 签名。复制完最终资源后，从内到外签名以生成 CodeResources。
  log.info({ file: log.filePath(app) }, "ad-hoc signing macOS arm64 app")
  await signAsync({
    app,
    platform: "darwin",
    identity: "-",
    identityValidation: false,
    preAutoEntitlements: false,
    optionsForFile: () => ({ hardenedRuntime: false, timestamp: "none" }),
  })
}
