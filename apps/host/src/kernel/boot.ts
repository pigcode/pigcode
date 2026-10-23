/** 在 Host 启动后把 boot graph 写到 profile 目录，main 的 protocol 直接读取。 */
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { buildBootGraph, type PluginEnvInput } from "../services/plugin-manager"

/** 构建并持久化 boot.json；渲染进程通过 pigcode-plugin://boot.json 读取。 */
export async function writeBootGraph(input: PluginEnvInput): Promise<void> {
  const profileDir = typeof input === "string" ? input : input.profileDir
  const graph = await buildBootGraph(input)
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, "boot.json"), JSON.stringify(graph), "utf8")
}
