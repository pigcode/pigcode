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
