/** 传输层只负责收发消息；v1.0 用 MessagePort，测试用内存实现。 */
export interface HostTransport {
  send(message: unknown): void
  onMessage(listener: (message: unknown) => void): () => void
  close(): void
}
