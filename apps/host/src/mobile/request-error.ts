export type MobileErrorCode =
  | "METHOD_NOT_AVAILABLE"
  | "INVALID_PARAMS"
  | "RESOURCE_NOT_AVAILABLE"
  | "RESULT_TOO_LARGE"
  | "COMMAND_FAILED"
  | "COMMAND_ID_CONFLICT"
  | "DEVICE_REVOKED"
  | "THREAD_BUSY"
  | "RUN_QUEUE_FULL"
  | "DRAFT_SELECTION_UNAVAILABLE"
  | "QUEUE_MESSAGE_UNAVAILABLE"
  | "QUEUE_STALE_RUN"
  | "QUEUE_LIMIT"
  | "QUEUE_TEXT_TOO_LONG"
  | "ATTACHMENT_TOO_LARGE"
  | "ATTACHMENT_UNSUPPORTED_TYPE"
  | "ATTACHMENT_NOT_FOUND"
  | "ATTACHMENT_FORBIDDEN"
  | "ATTACHMENT_LIMIT_EXCEEDED"
  | "ATTACHMENT_HASH_MISMATCH"
  | "PREVIEW_DISABLED"
  | "PREVIEW_URL_NOT_ALLOWED"
  | "PREVIEW_UNREACHABLE"
  | "PREVIEW_TIMEOUT"
  | "PREVIEW_TOO_LARGE"
  | "PREVIEW_STREAM_NOT_FOUND"
  | "WORKBENCH_FILE_CONFLICT"
  | "WORKBENCH_PATH_EXISTS"
  | "WORKBENCH_PATH_FORBIDDEN"
  | "WORKBENCH_DIR_NOT_EMPTY"
  | "WORKBENCH_FILE_TOO_LARGE"
  | "WORKBENCH_WRITE_SESSION_NOT_FOUND"
  | "WORKBENCH_HASH_MISMATCH"
  | "PR_ACTION_FAILED"
  | "TERMINAL_NOT_FOUND"
  | "TERMINAL_READ_ONLY"
  | "TERMINAL_LIMIT_EXCEEDED"

export const mobileErrorMessages: Record<MobileErrorCode, string> = {
  METHOD_NOT_AVAILABLE: "手机端暂时无法使用此操作。",
  INVALID_PARAMS: "请求参数无效，请检查手机端版本。",
  RESOURCE_NOT_AVAILABLE: "电脑上的这个项目、会话或记录已不可用。",
  RESULT_TOO_LARGE: "此摘要超出手机端可读取的大小。",
  COMMAND_FAILED: "电脑暂时无法处理此请求。",
  COMMAND_ID_CONFLICT: "这个命令编号已用于另一项操作。",
  DEVICE_REVOKED: "这部手机的配对已失效。",
  THREAD_BUSY: "会话已有运行中的一轮，请等它结束后再发送。",
  RUN_QUEUE_FULL: "电脑的运行队列已满，请稍后发送。",
  DRAFT_SELECTION_UNAVAILABLE: "草稿选中的项目、Agent 实例、模型或权限已不可用。",
  QUEUE_MESSAGE_UNAVAILABLE: "这条待发消息已处理或不可用。",
  QUEUE_STALE_RUN: "当前运行已变化，请重新查看队列。",
  QUEUE_LIMIT: "待发队列已满，请稍后发送。",
  QUEUE_TEXT_TOO_LONG: "这条消息太长，无法加入待发队列。",
  ATTACHMENT_TOO_LARGE: "图片超过允许的大小上限。",
  ATTACHMENT_UNSUPPORTED_TYPE: "不支持的图片格式或文件已损坏。",
  ATTACHMENT_NOT_FOUND: "图片附件不存在或已过期。",
  ATTACHMENT_FORBIDDEN: "无权访问此图片附件。",
  ATTACHMENT_LIMIT_EXCEEDED: "单条消息最多附带 6 张图片。",
  ATTACHMENT_HASH_MISMATCH: "图片校验失败，请重新上传。",
  PREVIEW_DISABLED: "电脑端未开启手机本机预览。",
  PREVIEW_URL_NOT_ALLOWED: "仅允许访问电脑本机 localhost HTTP/HTTPS 预览地址。",
  PREVIEW_UNREACHABLE: "无法连接电脑本机预览服务，请确认服务已启动。",
  PREVIEW_TIMEOUT: "本机预览请求超时。",
  PREVIEW_TOO_LARGE: "预览响应或请求超出大小上限。",
  PREVIEW_STREAM_NOT_FOUND: "预览数据流已过期或关闭。",
  WORKBENCH_FILE_CONFLICT: "电脑上的文件已被修改，请重新加载或确认覆盖。",
  WORKBENCH_PATH_EXISTS: "目标文件或目录已存在。",
  WORKBENCH_PATH_FORBIDDEN: "路径受保护或超出工作区范围，无法写入。",
  WORKBENCH_DIR_NOT_EMPTY: "目录非空，请确认是否删除目录及其全部内容。",
  WORKBENCH_FILE_TOO_LARGE: "文件内容超出手机端可保存的大小上限。",
  WORKBENCH_WRITE_SESSION_NOT_FOUND: "文件保存会话已过期，请重试保存。",
  WORKBENCH_HASH_MISMATCH: "文件传输校验失败，请重试保存。",
  PR_ACTION_FAILED: "执行 GitHub PR 操作失败，请检查仓库、权限或合并冲突。",
  TERMINAL_NOT_FOUND: "这个终端已关闭或不再可用。",
  TERMINAL_READ_ONLY: "电脑端打开的终端在手机上仅支持只读查看。",
  TERMINAL_LIMIT_EXCEEDED: "当前会话手机端同时打开的终端数量已达上限。",
}

export class MobileRequestError extends Error {
  constructor(readonly code: MobileErrorCode) {
    super(mobileErrorMessages[code])
  }
}

export function mobileParams<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  input: unknown,
): T {
  const result = schema.safeParse(input === undefined ? {} : input)
  if (!result.success) throw new MobileRequestError("INVALID_PARAMS")
  return result.data
}
