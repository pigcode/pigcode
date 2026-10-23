/** Provider 列表、能力与默认 agent 的查询辅助；供聊天与设置容器共用。 */
import type { ProviderCapabilities, Thread } from "@pigcode/contracts"
import type { AppStore, Connection } from "@pigcode/client-runtime"

/** provider.list 返回的一项；能力描述用于驱动 UI。 */
export interface ProviderInfo {
  id: string
  displayName: string
  capabilities: ProviderCapabilities
}

/** 读取 provider 列表。 */
export async function listProviders(connection: Connection): Promise<ProviderInfo[]> {
  return (await connection.call("provider.list", {})) as ProviderInfo[]
}

/** 按线程当前 provider 刷新能力；输入框的模型目录由聊天容器按 agent 懒加载。 */
export async function loadProviderContext(
  connection: Connection,
  store: AppStore,
  thread: Thread,
): Promise<void> {
  const providerId = thread.lastProviderId ?? thread.defaultProviderId
  // 切换线程时先清空上一线程的能力，避免短暂显示错误的控件。
  store.update({ providerCapabilities: null })
  const providers = await listProviders(connection)
  const capabilities = providers.find((provider) => provider.id === providerId)?.capabilities
  store.update({ providerCapabilities: capabilities ?? null })
}

/**
 * agent 集合或设置变了（插件启停、安装卸载、改了设置）：刷新当前线程的能力，
 * 并递增 providerRevision，让输入框重新读取 agent 列表与模型目录。失败不影响调用方的操作。
 */
export async function refreshProviderViews(deps: {
  connection: Connection
  store: AppStore
}): Promise<void> {
  try {
    const providers = await listProviders(deps.connection)
    const snapshot = deps.store.getSnapshot()
    const thread = snapshot.threads.find((item) => item.id === snapshot.activeThreadId)
    if (thread) {
      const providerId = thread.lastProviderId ?? thread.defaultProviderId
      deps.store.update({
        providerCapabilities:
          providers.find((provider) => provider.id === providerId)?.capabilities ?? null,
      })
    }
  } catch {
    // 能力刷新失败时保持原样；revision 仍然递增，让输入框自己重读。
  }
  deps.store.update({ providerRevision: deps.store.getSnapshot().providerRevision + 1 })
}

/** 询问 Host 新会话的默认 agent；没有任何可用的 agent 时为 null。 */
export async function pickProviderId(connection: Connection): Promise<string | null> {
  const result = (await connection.call("provider.default", {})) as { id?: unknown }
  return typeof result.id === "string" && result.id.length > 0 ? result.id : null
}
