/**
 * 共享模块的就位入口（ADR-0002）。
 *
 * 渲染进程在加载任何插件之前先 import 这个模块：它按顺序载入 index.html 的 import map 指向的那几个
 * 模块（React、ReactDOM、JSX runtime、`@pigcode/ui-primitives`、插件 SDK），对应 `shared/*.js`。
 * 模块只会在第一次载入时执行，之后插件按包名 import 拿到的是同一份实例。
 *
 * 这里的语句故意没有可合并的导出：它们的作用是「先载入」，不是给宿主用的 API。
 */
import "./react"
import "./react-dom"
import "./react-dom-client"
import "./jsx-runtime"
import "./jsx-dev-runtime"
import "./ui-primitives"
import "./plugin-sdk"
