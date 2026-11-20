const messages = {
  zh: {
    compact: "压缩后继续",
    keep: "保留完整上下文",
    never: "以后不再询问",
    header: "恢复会话",
    question: (minutes: number, tokens: string) =>
      `此会话已空闲 ${minutes} 分钟，约 ${tokens} 个 token。是否压缩上下文后继续？`,
  },
  en: {
    compact: "Compact and continue",
    keep: "Keep full context",
    never: "Never ask again",
    header: "Resume session",
    question: (minutes: number, tokens: string) =>
      `This session has been idle for ${minutes} minutes and uses about ${tokens} tokens. Compact the context before continuing?`,
  },
}

export function resumeReturnLabels(locale: string) {
  return locale.toLowerCase().startsWith("zh") ? messages.zh : messages.en
}
