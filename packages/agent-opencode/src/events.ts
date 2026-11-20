/** SSE 可跨网络分块、带 CRLF 和多行 data。 */
export async function* serverEvents(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
    throw new Error("OpenCode did not return an event stream")
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += chunk.value
      let end = buffer.search(/\r?\n\r?\n/)
      while (end >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + (buffer[end] === "\r" ? 4 : 2))
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n")
        if (data) {
          const event: unknown = JSON.parse(data)
          if (typeof event === "object" && event !== null && !Array.isArray(event))
            yield event as Record<string, unknown>
        }
        end = buffer.search(/\r?\n\r?\n/)
      }
      if (buffer.length > 8 * 1024 * 1024)
        throw new Error("OpenCode event exceeded the maximum size")
    }
    throw new Error("OpenCode event stream closed before the turn completed")
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
