import { join } from "node:path"
import { Arch, type AfterPackContext } from "electron-builder"
import { copyCursorRuntime } from "./cursor-runtime.ts"
import signMacArm64 from "./sign-macos-arm64.ts"

export default async function afterPack(context: AfterPackContext): Promise<void> {
  await copyCursorRuntime(
    context.packager.getResourcesDir(context.appOutDir),
    context.electronPlatformName,
    Arch[context.arch],
    join(context.packager.projectDir, "..", "..", "pnpm-lock.yaml"),
  )
  await signMacArm64(context)
}
