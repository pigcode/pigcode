/** Claude 的 AskUserQuestion：从工具输入读出问题，把用户的回答写回工具输入。 */
import type { AgentQuestion } from "@pigcode/plugin-sdk"

/** 从工具输入里读出问题；形状不对时返回 null。 */
export function parseQuestions(input: unknown): AgentQuestion[] | null {
  const list = (input as { questions?: unknown } | null)?.questions
  if (!Array.isArray(list) || list.length === 0) return null
  const questions: AgentQuestion[] = []
  for (const entry of list as Array<Record<string, unknown> | null>) {
    if (typeof entry?.question !== "string" || !entry.question.trim()) return null
    const options = Array.isArray(entry.options)
      ? (entry.options as Array<Record<string, unknown> | null>).flatMap((option) =>
          typeof option?.label === "string" && option.label.trim()
            ? [
                {
                  label: option.label,
                  ...(typeof option.description === "string" && option.description
                    ? { description: option.description }
                    : {}),
                },
              ]
            : [],
        )
      : []
    questions.push({
      question: entry.question,
      ...(typeof entry.header === "string" && entry.header ? { header: entry.header } : {}),
      options,
      multiSelect: entry.multiSelect === true,
    })
  }
  return questions
}

/**
 * AskUserQuestion 要的答案形状：问题原文 → 选中的选项（多选用逗号连接）。
 * answers 与问题顺序一致；没答的问题不写入。
 */
export function answerRecord(
  questions: AgentQuestion[],
  answers: string[],
): Record<string, string> {
  const record: Record<string, string> = {}
  questions.forEach((question, index) => {
    const answer = answers[index]?.trim()
    if (answer) record[question.question] = answer
  })
  return record
}
