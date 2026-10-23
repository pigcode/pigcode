/** 示例 agent（provider）插件：把用户输入原样回显，演示设置字段怎样传到 driver。 */
import type {
  PluginHostContext,
  ProviderPluginDriver,
  ProviderSettingsValues,
} from "@pigcode/plugin-sdk"

export const name = "provider-echo"
export const inject = ["providers"]

/** 设置值来自用户输入，读取时校验类型；第三方插件只能 import type，运行时不依赖 SDK。 */
function text(settings: ProviderSettingsValues | undefined, key: string): string {
  const value = settings?.[key]
  return typeof value === "string" ? value.trim() : ""
}

export function apply(ctx: PluginHostContext): void {
  // 每个 run 开始前 Host 都会用最新的设置调用 createSession；按会话记下这一份。
  const settingsBySession = new Map<string, ProviderSettingsValues>()
  const driver: ProviderPluginDriver = {
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
      // 会话 id 是 Host 数据库的主键：复用时沿用 Host 给的 id，新会话必须全局唯一。
      const id = input.sessionId ?? `echo_${crypto.randomUUID()}`
      settingsBySession.set(id, input.settings ?? {})
      return {
        id,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: null,
        permissionMode: "workspace-write",
        model: null,
      }
    },
    async send(session, input, runtime) {
      const settings = settingsBySession.get(session.id)
      const prefix = text(settings, "prefix")
      const body = settings?.uppercase === true ? input.text.toUpperCase() : input.text
      const reply = prefix ? `${prefix} ${body}` : body
      runtime.emit({ type: "run.started" })
      runtime.emit({ type: "message.delta", text: reply })
      runtime.emit({ type: "message.completed", text: reply })
      runtime.emit({ type: "run.completed" })
    },
    async interrupt() {},
    async dispose(session) {
      settingsBySession.delete(session.id)
    },
  }
  ctx.providers.register(driver)
  // 热停用时必须注销，否则 agent 仍会出现在输入框的选择器里。
  ctx.effect(() => () => ctx.providers.unregister("echo"))
}
