/** Host 包的 CLI 入口；Electron utilityProcess 入口见 `entry.ts`，无窗口入口见 `headless.ts`。 */
import { runCli } from "./kernel/cli"

export { runCli } from "./kernel/cli"
export { runHeadlessCli, type HeadlessCliDeps } from "./kernel/headless-cli"

if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  void runCli(process.argv.slice(2)).then((code) => process.exit(code))
}
