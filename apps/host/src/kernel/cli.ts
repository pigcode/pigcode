/** `pigcode` CLI 的最小入口：目前只支持 --dump-config。 */
import { fileURLToPath } from "node:url"
import { createHostApp, dumpConfig } from "./app"

/** 默认 profile 目录：`apps/host/profiles`（源码与构建产物均可定位）。 */
const defaultProfileDir = fileURLToPath(new URL("../../profiles", import.meta.url))

/** 解析参数并在需要时创建 kernel；返回进程退出码。 */
export async function runCli(argv: string[]): Promise<number> {
  const profileIndex = argv.indexOf("--profile")
  const profileName = profileIndex >= 0 ? argv[profileIndex + 1] : "desktop"
  if (!profileName) {
    console.error("missing --profile value")
    return 2
  }
  const profileDir = process.env.PIGCODE_PROFILE_DIR ?? defaultProfileDir
  const ctx = await createHostApp({ profileDir, profileName })
  if (argv.includes("--dump-config")) {
    console.log(JSON.stringify(dumpConfig(ctx), null, 2))
    await ctx.fiber.dispose()
    return 0
  }
  console.error("no command; use --dump-config")
  await ctx.fiber.dispose()
  return 2
}
