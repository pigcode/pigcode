/**
 * 共享模块 `react/jsx-runtime`：产物固定在 `shared/jsx-runtime.js`。
 * 插件用自动 JSX runtime 编译（jsx: "automatic"）后，编译结果 import 的就是这个裸包名，
 * 拿到宿主的同一个 runtime。
 */
export { Fragment, jsx, jsxs } from "react/jsx-runtime"
