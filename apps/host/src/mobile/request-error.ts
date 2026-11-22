export type MobileErrorCode =
  | "METHOD_NOT_AVAILABLE"
  | "INVALID_PARAMS"
  | "RESOURCE_NOT_AVAILABLE"
  | "RESULT_TOO_LARGE"
  | "COMMAND_FAILED"

export const mobileErrorMessages: Record<MobileErrorCode, string> = {
  METHOD_NOT_AVAILABLE: "手机端暂时无法使用此操作。",
  INVALID_PARAMS: "请求参数无效，请检查手机端版本。",
  RESOURCE_NOT_AVAILABLE: "电脑上的这个项目、会话或记录已不可用。",
  RESULT_TOO_LARGE: "此摘要超出手机端可读取的大小。",
  COMMAND_FAILED: "电脑暂时无法处理此请求。",
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
