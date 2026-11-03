/** 文件 Surface 用到的翻译函数类型。 */
import type { MessageKey } from "@pigcode/ui-primitives"

/** useLocale() 暴露的 t 函数签名。 */
export type Translate = (key: MessageKey) => string
