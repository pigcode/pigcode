/** Provider 列表、能力与模型目录的查询辅助；供聊天与设置容器共用。 */
import type { ProviderCapabilities, Thread } from "@pigcode/contracts"
import type { AppStore, Connection } from "@pigcode/client-runtime"
import type { ProviderDetection, ProviderStatus } from "@pigcode/ui-settings"

/** provider.list 返回的一项；能力描述用于驱动 UI。 */
export interface ProviderInfo {
  id: string
  displayName: string
  capabilities: ProviderCapabilities
}

/** provider.models 返回的模型条目；M2 只消费 id。 */
interface ProviderModelInfo {
  id: string
}

/** provider.detect 返回的 Codex 检测字段；authMethod 由 UI 层补空。 */
export interface CodexDetection {
  installed: boolean
  version: string | null
  loggedIn: boolean
  command: string
  error: string | null
}

/** 读取 provider 列表。 */
export async function listProviders(connection: Connection): Promise<ProviderInfo[]> {
  return (await connection.call("provider.list", {})) as ProviderInfo[]
}

/** 读取某个 provider 的模型目录并写入全局状态。 */
export async function loadProviderModels(
  connection: Connection,
  store: AppStore,
  providerId: string,
): Promise<void> {
  const models = (await connection.call("provider.models", { providerId })) as ProviderModelInfo[]
  store.update({
    providerModels: models.flatMap((model) =>
      typeof model.id === "string" && model.id.length > 0 ? [model.id] : [],
    ),
  })
}

/** 按线程当前 provider 刷新能力与模型列表。 */
export async function loadProviderContext(
  connection: Connection,
  store: AppStore,
  thread: Thread,
): Promise<void> {
  const providerId = thread.lastProviderId ?? thread.defaultProviderId
  // 切换线程时先清空上一线程的能力，避免短暂显示错误的控件。
  store.update({ providerCapabilities: null, providerModels: [] })
  const providers = await listProviders(connection)
  const capabilities = providers.find((provider) => provider.id === providerId)?.capabilities
  store.update({ providerCapabilities: capabilities ?? null })
  try {
    await loadProviderModels(connection, store, providerId)
  } catch {
    // 模型目录不可用时保留空列表，不阻塞聊天。
    store.update({ providerModels: [] })
  }
}

/** 把检测结果归一化为设置页的 provider 分区。 */
export function toProviderStatus(
  id: string,
  displayName: string,
  detection: ProviderDetection,
  capabilities: ProviderCapabilities | undefined,
): ProviderStatus {
  return {
    id,
    displayName,
    installed: detection.installed,
    version: detection.version,
    loggedIn: detection.loggedIn,
    authMethod: detection.authMethod,
    subscriptionType: detection.subscriptionType ?? null,
    command: detection.command ?? null,
    error: detection.error ?? null,
    ...(capabilities ? { capabilities } : {}),
  }
}

/** 询问 Host 当前默认 provider；失败时回退到 fake。 */
export async function pickProviderId(connection: Connection): Promise<string> {
  const result = (await connection.call("provider.default", {})) as { id?: unknown }
  return typeof result.id === "string" && result.id.length > 0 ? result.id : "fake"
}
