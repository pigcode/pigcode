import type { AgentRuntime } from "@pigcode/plugin-sdk"

interface CodexQuestion {
  id: string
  header: string
  question: string
  options?: Array<{ label: string; description: string }> | null
}

/** 计划模式的 request_user_input 使用已有的提问卡片；答案按原生问题 id 返回。 */
export async function answerCodexQuestions(params: unknown, runtime: AgentRuntime) {
  const questions = (params as { questions?: CodexQuestion[] }).questions ?? []
  if (!runtime.askQuestions || questions.length === 0) return { answers: {} }
  const answers = await runtime.askQuestions({
    questions: questions.map((question) => ({
      question: question.question,
      header: question.header,
      options: question.options ?? [],
      multiSelect: false,
    })),
  })
  return {
    answers: Object.fromEntries(
      questions.map((question, index) => [
        question.id,
        {
          answers: answers[index] === undefined ? [] : [answers[index]],
        },
      ]),
    ),
  }
}
