/**
 * 提问的历史行（参照 ZCode 的 ask-question）：「已询问 · N 个问题」，展开后逐条列出问题与回答。
 * 来源可以是提问事件，也可以是 Claude 的 AskUserQuestion 工具；运行中「正在询问」，不能展开。
 */
import { memo } from "react"
import { CircleHelp } from "lucide-react"
import { useLocale } from "@pigcode/ui-primitives"
import type { QuestionRequestView } from "../question-card"
import { askedQuestions, type AskedQuestion } from "../tool-fields"
import type { ToolCall } from "../tool-meta"
import { ToolRow } from "../tool-row"

interface AskQuestionRowProps {
  id: string
  questions: AskedQuestion[]
  running: boolean
  showIcon?: boolean | undefined
}

function AskQuestionRow({ id, questions, running, showIcon = true }: AskQuestionRowProps) {
  const { t } = useLocale()
  const answered = questions.some((question) => question.answer !== undefined)
  return (
    <ToolRow
      id={id}
      icon={CircleHelp}
      showIcon={showIcon}
      kind={running ? t("chat.askQuestion.asking") : t("chat.askQuestion.asked")}
      running={running}
      secondary={
        running
          ? null
          : answered
            ? t("chat.askQuestion.questionsCount").replace("{count}", String(questions.length))
            : t("chat.askQuestion.noAnswerProvided")
      }
      className={answered ? "question-done" : undefined}
      dataStatus={running ? "running" : "completed"}
    >
      {running
        ? undefined
        : () => (
            <ul className="tool-children ask-list">
              {questions.map((question, index) => (
                <li key={index}>
                  <p className="ask-question">{question.question}</p>
                  <p className="ask-answer">
                    {question.answer?.trim()
                      ? question.answer
                      : t("chat.askQuestion.noAnswerProvided")}
                  </p>
                </li>
              ))}
            </ul>
          )}
    </ToolRow>
  )
}

/** 来自提问事件的历史行；answers 按问题顺序，pending 表示还在等用户回答。 */
export const QuestionHistoryRow = memo(function QuestionHistoryRow({
  request,
  answers,
  pending = false,
}: {
  request: QuestionRequestView
  answers: string[] | undefined
  pending?: boolean | undefined
}) {
  const questions = request.questions.map((question, index) => ({
    question: question.question,
    header: question.header,
    answer: answers?.[index] || undefined,
  }))
  return <AskQuestionRow id={`question-${request.id}`} questions={questions} running={pending} />
})

/** 来自 AskUserQuestion 工具的历史行。 */
export const AskToolRow = memo(function AskToolRow({
  tool,
  showIcon = true,
}: {
  tool: ToolCall
  showIcon?: boolean | undefined
}) {
  return (
    <AskQuestionRow
      id={tool.id}
      questions={askedQuestions(tool)}
      running={tool.status === "running"}
      showIcon={showIcon}
    />
  )
})
