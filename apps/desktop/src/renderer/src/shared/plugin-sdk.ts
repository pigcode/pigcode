/**
 * 共享模块 `@pigcode/plugin-sdk`：产物固定在 `shared/plugin-sdk.js`。
 *
 * 只导出浏览器侧的那部分（`@pigcode/plugin-sdk/client`）：manifest 校验、Host 入口与 Node 辅助函数
 * 会带上 zod、semver 和 Node 内置模块，不能进渲染进程。类型在编译时被擦除，插件写
 * `import type { ClientPluginContext } from "@pigcode/plugin-sdk"` 时不需要运行时依赖。
 */
export { defineClientPlugin } from "@pigcode/plugin-sdk/client"
