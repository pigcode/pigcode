/** 聊天页容器的辅助函数与连接/附件/会话操作封装。 */
import { useCallback, useMemo } from "react"
import type { PermissionMode, Thread } from "@pigcode/contracts"
import type { AppStore, Connection } from "@pigcode/client-runtime"
import { copyText, type MessageKey } from "@pigcode/ui-primitives"
import type { ChatLinkActions } from "@pigcode/ui-chat"
import type { ComposerAttachmentUploadInput, ComposerModelChoice } from "@pigcode/ui-composer"
import { dismissSpawnedTab, selectThreadTab } from "./thread-tabs"

/** 把 unknown 错误转成可展示文本。 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 项目内的文件转成相对路径；项目外的文件不在文件标签里打开。 */
export function projectRelative(
  path: string | undefined,
  root: string | undefined,
): string | undefined {
  if (!path) return undefined
  const windows = /^(?:[a-z]:[\\/]|\\\\)/i.test(path)
  if (!path.startsWith("/") && !windows) return path
  if (!root) return undefined
  const absolute = windows ? path.replaceAll("\\", "/") : path
  const folder = windows ? root.replaceAll("\\", "/") : root
  const prefix = folder.endsWith("/") ? folder : `${folder}/`
  return absolute.startsWith(prefix) ? absolute.slice(prefix.length) : undefined
}

/** 用 Host 返回的线程记录替换 store 里的同 id 线程。 */
export function patchThread(store: AppStore, threadId: string, patch: Partial<Thread>): void {
  const threads = store
    .getSnapshot()
    .threads.map((item) => (item.id === threadId ? { ...item, ...patch } : item))
  store.update({ threads })
}

/** 聊天消息内链接的右键菜单与外链打开操作。 */
export function useChatLinkActions({
  onOpenLinkTab,
  fail,
  t,
}: {
  onOpenLinkTab?: ((url: string) => void) | undefined
  fail: (error: unknown) => void
  t: (key: MessageKey) => string
}): ChatLinkActions | undefined {
  return useMemo<ChatLinkActions | undefined>(() => {
    const { browser, popupMenu } = window.pigcodeNative ?? {}
    if (!browser || !popupMenu || !onOpenLinkTab) return undefined

    const openExternal = (url: string) => {
      void browser.openExternal(url).catch(() => fail(t("chat.link.openFailed")))
    }
    return {
      openExternal,
      showMenu: (url, point) => {
        const web = /^https?:/i.test(url)
        const items = [
          ...(web ? [{ id: "new-tab", label: t("chat.link.newTab") }] : []),
          {
            id: "open-external",
            label: t(web ? "chat.link.defaultBrowser" : "chat.link.openEmail"),
          },
          { type: "separator" as const },
          { id: "copy-link", label: t("chat.link.copy") },
          ...(web ? [{ id: "save-link", label: t("chat.link.saveAs") }] : []),
        ]
        void popupMenu(items, point)
          .then(async (choice) => {
            if (choice === "new-tab" && web) onOpenLinkTab(url)
            else if (choice === "open-external") openExternal(url)
            else if (choice === "copy-link") await copyText(url)
            else if (choice === "save-link" && web) {
              await browser.saveLink(url).catch(() => fail(t("chat.link.saveFailed")))
            }
          })
          .catch(fail)
      },
    }
  }, [fail, onOpenLinkTab, t])
}

/** 当前会话的图片附件上传、按需读取与内存缓存读取回调。 */
export function useChatAttachmentActions(connection: Connection, threadId: string | null) {
  const uploadImage = useCallback(
    (input: ComposerAttachmentUploadInput) =>
      connection.uploadAttachment({
        ...input,
        ...(threadId ? { threadId } : {}),
      }),
    [connection, threadId],
  )

  const readAttachment = useCallback(
    (attachmentId: string, variant: "thumb" | "full") =>
      connection.readAttachmentDataUrl({
        attachmentId,
        ...(threadId ? { threadId } : {}),
        variant,
      }),
    [connection, threadId],
  )

  const peekAttachment = useCallback(
    (attachmentId: string, variant: "thumb" | "full") =>
      connection.peekAttachmentDataUrl({
        attachmentId,
        ...(threadId ? { threadId } : {}),
        variant,
      }),
    [connection, threadId],
  )

  return { uploadImage, readAttachment, peekAttachment }
}

/** 构造会话模型切换、权限模式、计划模式与关闭子代理标签的操作集合。 */
export function createChatThreadActions({
  connection,
  store,
  thread,
  mainId,
  selectedTab,
  agents,
  t,
  setNotice,
  fail,
}: {
  connection: Connection
  store: AppStore
  thread: Thread | null
  mainId: string | null
  selectedTab: string
  agents: ReadonlyArray<{ id: string; label: string }>
  t: (key: MessageKey) => string
  setNotice: (message: string | null) => void
  fail: (error: unknown) => void
}) {
  /** 切换 Agent 实例与模型；换了实例时提示上下文以摘要交接。 */
  function selectModel(choice: ComposerModelChoice): void {
    if (!thread) return
    const previousInstance = thread.lastInstanceId ?? thread.defaultInstanceId ?? null
    void connection
      .call("thread.switchAgent", {
        threadId: thread.id,
        agentId: choice.agentId,
        instanceId: choice.instanceId,
        modelId: choice.modelId,
      })
      .then((result) => {
        const modes = result as { permissionMode?: string; planMode?: boolean }
        patchThread(store, thread.id, {
          ...(modes.permissionMode ? { permissionMode: modes.permissionMode } : {}),
          ...(typeof modes.planMode === "boolean" ? { planMode: modes.planMode } : {}),
          lastAgentId: choice.agentId,
          lastInstanceId: choice.instanceId,
          lastModelId: choice.modelId,
        })
        if (choice.instanceId !== previousInstance) {
          const name =
            agents.find((agent) => agent.id === choice.instanceId)?.label ?? choice.instanceId
          setNotice(`${t("chat.agent.next")} ${name}`)
        }
      })
      .catch(fail)
  }

  function setPermissionMode(mode: PermissionMode): void {
    if (!thread) return
    patchThread(store, thread.id, { permissionMode: mode })
    void connection
      .call("thread.setPermissionMode", { threadId: thread.id, permissionMode: mode })
      .catch((error: unknown) => {
        patchThread(store, thread.id, { permissionMode: thread.permissionMode })
        fail(error)
      })
  }

  function setPlanMode(planMode: boolean): void {
    if (!thread) return
    void connection
      .call("thread.setPlanMode", { threadId: thread.id, planMode })
      .then((updated) => patchThread(store, thread.id, updated as Thread))
      .catch(fail)
  }

  /** 关闭子代理标签：用户添加的归档（还在跑的 run 会停下），派生的只是不再显示。 */
  function closeTab(tabId: string): void {
    if (!mainId) return
    if (tabId.startsWith("spawned:")) {
      dismissSpawnedTab(mainId, tabId.slice("spawned:".length))
      return
    }
    if (!tabId.startsWith("agent:")) return
    const childId = tabId.slice("agent:".length)
    if (selectedTab === tabId) selectThreadTab(mainId, "main")
    void connection
      .call("thread.archive", { threadId: childId })
      .then((archived) => {
        patchThread(store, childId, archived as Thread)
        store.closeThread(childId)
        void connection.closeThread(childId).catch(() => undefined)
      })
      .catch(fail)
  }

  return { selectModel, setPermissionMode, setPlanMode, closeTab }
}
