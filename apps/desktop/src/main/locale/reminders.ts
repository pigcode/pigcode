import type { HostReminder } from "@pigcode/contracts"

const ZH_CN = {
  approval: "等你处理",
  question: "等你处理",
  completed: "已完成",
  failed: "运行失败",
}

const EN_US = {
  approval: "Needs your attention",
  question: "Needs your attention",
  completed: "Run completed",
  failed: "Run failed",
}

export function reminderText(locale: string, kind: HostReminder["kind"]): string {
  return (locale.toLowerCase().startsWith("zh") ? ZH_CN : EN_US)[kind]
}
