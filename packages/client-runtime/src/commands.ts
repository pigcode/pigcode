/** 类型化的 RPC 命令封装，避免 UI 直接拼方法名。 */
import type { Project, Thread } from "@pigcode/contracts"
import type { RpcClient } from "./rpc-client"

/** 创建项目与线程相关的类型化命令集合。 */
export function createCommands(client: RpcClient) {
  return {
    listProjects: () => client.call("project.list", {}) as Promise<Project[]>,
    addProject: (rootPath: string, name?: string) =>
      client.call("project.add", name ? { rootPath, name } : { rootPath }) as Promise<Project>,
    listThreads: (projectId?: string) =>
      client.call("thread.list", { projectId }) as Promise<Thread[]>,
    createThread: (projectId: string, title: string, providerId: string) =>
      client.call("thread.create", { projectId, title, providerId }) as Promise<Thread>,
  }
}
