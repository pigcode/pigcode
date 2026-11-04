/** client-plugins 的测试共用：生成 client bundle 入口、让 reload 读到给定的 boot graph、建好控制器。 */
import { vi } from "vitest"
import {
  Connection,
  createExtensionRegistry,
  type BootEntry,
  type ClientModule,
} from "@pigcode/client-runtime"
import { createClientPluginController } from "./client-plugins"

/** 控制器只在 reload 时使用 connection.call，这里不会真正发起 RPC。 */
const connection = new Connection({ onEvent() {}, onDelta() {}, onStatus() {} })

/** 一个 apply 体为 body 的 client bundle 入口。 */
export function entry(id: string, body: string, revision = "1"): BootEntry {
  const source = `export function apply(ctx) {\n${body}\n}`
  return { id, revision, inject: [], url: `data:text/javascript,${encodeURIComponent(source)}` }
}

/** 让 reload 读到给定的 boot graph。 */
export function serve(entries: BootEntry[]): void {
  vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ entries }) }))
}

/** 控制器与它用的扩展点注册表；importModule 缺省时真的 import data URL。 */
export function setup(importModule?: (url: string) => Promise<ClientModule>) {
  const extensions = createExtensionRegistry()
  const controller = createClientPluginController({
    extensions,
    connection,
    ...(importModule ? { importModule } : {}),
  })
  return { extensions, controller }
}

/** 一个 Surface 的登记语句。 */
export const surfaceCall = (id: string, title: string) =>
  `ctx.surfaces.register({ id: ${JSON.stringify(id)}, title: ${JSON.stringify(title)}, render() {} })`

/** 一个可以从外面完成的 promise。 */
export function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
