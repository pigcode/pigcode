/** 经由桌面控制端口请求 Electron main 使用 nativeImage 生成图片缩略图。 */
import { randomUUID } from "node:crypto"
import type { HostTransport } from "@pigcode/client-runtime/transport"
import { attachmentThumbnailResultSchema } from "@pigcode/contracts"
import type { AttachmentThumbnailer } from "./attachments"

const THUMBNAIL_TIMEOUT_MS = 5_000

/** 构造基于桌面 controlPort 的缩略图生成器；超时或桌面不可用时返回 null，调用方退回原图。 */
export function desktopAttachmentThumbnailer(transport: HostTransport): AttachmentThumbnailer {
  return (input, options) => {
    const id = randomUUID()
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        unsubscribe()
        resolve(null)
      }, THUMBNAIL_TIMEOUT_MS)
      const unsubscribe = transport.onMessage((message) => {
        const reply = attachmentThumbnailResultSchema.safeParse(message)
        if (!reply.success || reply.data.id !== id) return
        clearTimeout(timeout)
        unsubscribe()
        if (!reply.data.dataBase64) {
          resolve(null)
          return
        }
        resolve(Buffer.from(reply.data.dataBase64, "base64"))
      })
      try {
        transport.send({
          type: "attachment.thumbnail",
          id,
          dataBase64: input.toString("base64"),
          maxEdge: options.maxEdge,
          maxBytes: options.maxBytes,
        })
      } catch {
        clearTimeout(timeout)
        unsubscribe()
        resolve(null)
      }
    })
  }
}
