/** Electron main 侧图片缩略图生成：使用内置 nativeImage 将长边缩放并压到指定体积内。 */
import { attachmentThumbnailRequestSchema } from "@pigcode/contracts"
import { nativeImage, type MessagePortMain } from "electron"

const JPEG_QUALITIES = [85, 75, 65, 55, 45, 35, 25] as const
const FALLBACK_SCALE_FACTORS = [0.75, 0.5] as const
const FALLBACK_QUALITIES = [50, 35, 25] as const

function resizeLongEdge(
  image: ReturnType<typeof nativeImage.createFromBuffer>,
  maxEdge: number,
): ReturnType<typeof nativeImage.createFromBuffer> {
  const { width, height } = image.getSize()
  if (width <= 0 || height <= 0 || Math.max(width, height) <= maxEdge) return image
  return width >= height ? image.resize({ width: maxEdge }) : image.resize({ height: maxEdge })
}

/** 将图片缓冲缩放并编码为不超过 maxBytes 的 JPEG；无法解码或无法压到体积内时返回 null。 */
export function generateThumbnail(
  input: Buffer,
  maxEdge: number,
  maxBytes: number,
): Buffer | null {
  try {
    const decoded = nativeImage.createFromBuffer(input)
    if (decoded.isEmpty()) return null
    const { width, height } = decoded.getSize()
    if (width <= 0 || height <= 0) return null

    const scaled = resizeLongEdge(decoded, maxEdge)
    for (const quality of JPEG_QUALITIES) {
      const encoded = scaled.toJPEG(quality)
      if (encoded.length > 0 && encoded.length <= maxBytes) return encoded
    }

    for (const factor of FALLBACK_SCALE_FACTORS) {
      const nextEdge = Math.max(64, Math.round(maxEdge * factor))
      const smaller = resizeLongEdge(decoded, nextEdge)
      for (const quality of FALLBACK_QUALITIES) {
        const encoded = smaller.toJPEG(quality)
        if (encoded.length > 0 && encoded.length <= maxBytes) return encoded
      }
    }
    return null
  } catch {
    return null
  }
}

/** 在 Host controlPort 上响应 `attachment.thumbnail` 请求。 */
export function attachAttachmentThumbnails(port: MessagePortMain): void {
  port.on("message", ({ data }) => {
    const request = attachmentThumbnailRequestSchema.safeParse(data)
    if (!request.success) return
    const { id, dataBase64, maxEdge, maxBytes } = request.data
    let result: string | null = null
    try {
      const encoded = generateThumbnail(Buffer.from(dataBase64, "base64"), maxEdge, maxBytes)
      if (encoded) result = encoded.toString("base64")
    } catch {
      result = null
    }
    port.postMessage({ type: "attachment.thumbnail.result", id, dataBase64: result })
  })
  port.start()
}
