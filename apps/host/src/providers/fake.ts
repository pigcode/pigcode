/** 确定性的 fake provider，用于验证协议、UI 和插件模型。 */
import type { ProviderCapabilities } from "@pigcode/contracts"
import { randomUUID } from "node:crypto"
import type {
  CreateSessionInput,
  ProviderDriver,
  ProviderRuntime,
  ProviderSessionHandle,
  UserInput,
} from "./driver"

/** fake provider 固定输出的文本分片。 */
const CHUNKS = ["Hello", " from", " fake", " provider"]

/** 不依赖外部进程的确定性 provider 实现。 */
export class FakeProviderDriver implements ProviderDriver {
  readonly id = "fake"
  readonly displayName = "Fake Provider"
  readonly capabilities: ProviderCapabilities = {
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
  }

  /** 创建一个仅存在于内存中的 provider 会话句柄。 */
  async createSession(input: CreateSessionInput): Promise<ProviderSessionHandle> {
    return {
      id: `ps_${randomUUID()}`,
      threadId: input.threadId,
      cwd: input.cwd,
      nativeSessionId: input.nativeSessionId ?? null,
      permissionMode: input.permissionMode ?? "workspace-write",
      model: input.model ?? null,
    }
  }

  /** 依次推送开始、分片、完成事件，保证事件顺序可预测。 */
  async send(
    _session: ProviderSessionHandle,
    _input: UserInput,
    runtime: ProviderRuntime,
  ): Promise<void> {
    runtime.emit({ type: "run.started" })
    for (const text of CHUNKS) runtime.emit({ type: "message.delta", text })
    runtime.emit({ type: "message.completed", text: CHUNKS.join("") })
    runtime.emit({ type: "run.completed" })
  }

  /** fake provider 没有可中断的工作。 */
  async interrupt(): Promise<void> {}

  /** fake provider 没有需要释放的资源。 */
  async dispose(): Promise<void> {}
}
