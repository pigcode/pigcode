/** Host 包的入口；M0-A 先暴露 CLI，utilityProcess 入口在 Task 10 接入。 */
import { runCli } from "./kernel/cli"

if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  void runCli(process.argv.slice(2)).then((code) => process.exit(code))
}
