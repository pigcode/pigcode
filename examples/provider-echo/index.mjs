/** 示例第三方 provider：把用户输入原样回显。 */
export const name = "provider-echo"
export const inject = ["providers"]

export function apply(ctx) {
  const driver = {
    id: "echo",
    displayName: "Echo",
    capabilities: {
      streaming: true,
      approvals: false,
      questions: false,
      plan: false,
      resume: false,
      fork: false,
      rollback: false,
      checkpoint: false,
      subagents: false,
      mcp: false,
      images: false,
      usage: false,
      modelCatalog: false,
      nativeSessionId: false,
    },
    async createSession(input) {
      return {
        id: `echo_${input.threadId}`,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: null,
        permissionMode: "workspace-write",
        model: null,
      }
    },
    async send(_session, input, runtime) {
      runtime.emit({ type: "run.started" })
      runtime.emit({ type: "message.delta", text: input.text })
      runtime.emit({ type: "message.completed", text: input.text })
      runtime.emit({ type: "run.completed" })
    },
    async interrupt() {},
    async dispose() {},
  }
  ctx.providers.register(driver)
  ctx.effect(() => () => ctx.providers.unregister("echo"))
}
