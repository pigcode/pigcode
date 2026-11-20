import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { transformSync } from "esbuild"

export function writeAgyFixture(directory: string, managed = false, version = "1.5.13"): string {
  const source = readFileSync(new URL("./agy.ts", import.meta.url), "utf8").replaceAll(
    '"1.5.13"',
    JSON.stringify(version),
  )
  const script = join(directory, managed ? "antigravity" : "agy.mjs")
  writeFileSync(script, transformSync(source, { loader: "ts", format: "esm" }).code, {
    mode: 0o700,
  })
  if (process.platform !== "win32") return script
  const shim = join(directory, "agy.cmd")
  writeFileSync(shim, '@SETLOCAL\r\nnode "%~dp0agy.mjs" %*\r\n')
  return shim
}
