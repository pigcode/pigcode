/**
 * 共享模块 `@pigcode/ui-primitives`：产物固定在 `shared/ui-primitives.js`。
 *
 * 插件按包名 import，拿到的是宿主正在用的同一份组件、主题 token 与 hooks（`useTheme`、`useLocale`）。
 * 这也意味着 `@pigcode/ui-primitives` 的破坏性改动要按插件 apiVersion 处理（ADR-0002）。
 */
export * from "@pigcode/ui-primitives"
