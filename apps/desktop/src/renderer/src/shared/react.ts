/**
 * 共享模块 `react`：渲染进程和插件拿到的是同一个实例（ADR-0002）。
 *
 * 这个文件是 Vite 的独立入口，产物固定输出到 `shared/react.js`，由 index.html 的 import map 把裸包名
 * `react` 指过来。宿主的组件按普通 import 使用它，插件按包名 import 也落到同一个 URL，所以 hooks、
 * context 和 React 内部状态只有一份。
 *
 * 具名导出逐个列出而不是 `export *`：Rollup 的入口签名（preserveEntrySignatures: "strict"）下，
 * `export *` 会退化成只转发一个内部对象，插件的 `import { useState } from "react"` 就拿不到名字。
 */
import * as React from "react"

export const {
  Activity,
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  act,
  cache,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version,
} = React

export default React
