/** 示例 UI 插件：在调试侧栏添加一个面板。 */
export function apply(ctx) {
  ctx.registerPanel({
    id: "debug-panel",
    title: "Debug Panel",
    render(container) {
      container.textContent = "Hello from pigcode-ui-debug-panel"
    },
  })
}
