/**
 * agent 的提问卡片（Claude 的 AskUserQuestion）：每个问题列出选项（单选或多选），
 * 也可以填「其他」。全部答完才能提交；回答之后时间线里只留「已询问」的历史行。
 */
import { useState } from "react"
import { MessageCircleQuestion } from "lucide-react"
import { Button, useLocale } from "@pigcode/ui-primitives"

/** 一个问题。 */
export interface QuestionView {
  question: string
  header?: string | undefined
  options: Array<{ label: string; description?: string | undefined }>
  multiSelect: boolean
}

/** 一次提问。 */
export interface QuestionRequestView {
  id: string
  questions: QuestionView[]
}

interface Draft {
  selected: string[]
  other: string
}

/** 把一个问题的选择与补充合成一条答案。 */
function answerOf(draft: Draft): string {
  return [...draft.selected, draft.other.trim()].filter(Boolean).join(", ")
}

/** 渲染还没回答的提问。 */
export function QuestionCard({
  request,
  onAnswer,
}: {
  request: QuestionRequestView
  onAnswer: (requestId: string, answers: string[]) => void
}) {
  const { t } = useLocale()
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    request.questions.map(() => ({ selected: [], other: "" })),
  )

  function update(index: number, patch: (draft: Draft) => Draft): void {
    setDrafts((current) => current.map((draft, at) => (at === index ? patch(draft) : draft)))
  }

  function choose(index: number, question: QuestionView, label: string): void {
    update(index, (draft) => {
      if (!question.multiSelect) return { ...draft, selected: [label] }
      const selected = draft.selected.includes(label)
        ? draft.selected.filter((item) => item !== label)
        : [...draft.selected, label]
      return { ...draft, selected }
    })
  }

  const ready = drafts.every((draft) => answerOf(draft).length > 0)
  return (
    <form
      className="perm question-card"
      aria-label={t("chat.question.title")}
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) onAnswer(request.id, drafts.map(answerOf))
      }}
    >
      <div className="q">
        <MessageCircleQuestion className="ic" aria-hidden="true" />
        {t("chat.question.title")}
      </div>
      {request.questions.map((question, index) => {
        const draft = drafts[index] ?? { selected: [], other: "" }
        return (
          <fieldset key={question.question} className="question">
            <legend>
              {question.header ? <span className="question-header">{question.header}</span> : null}
              <span className="question-text">{question.question}</span>
              {question.multiSelect ? (
                <span className="question-hint">{t("chat.question.multi")}</span>
              ) : null}
            </legend>
            {question.options.map((option) => (
              <label key={option.label} className="question-option">
                <input
                  type={question.multiSelect ? "checkbox" : "radio"}
                  name={`${request.id}-${index}`}
                  checked={draft.selected.includes(option.label)}
                  onChange={() => choose(index, question, option.label)}
                />
                <span className="question-option-label">{option.label}</span>
                {option.description ? (
                  <span className="question-option-desc">{option.description}</span>
                ) : null}
              </label>
            ))}
            <input
              type="text"
              className="question-other"
              placeholder={t("chat.question.other")}
              aria-label={`${question.question} ${t("chat.question.other")}`}
              value={draft.other}
              onChange={(event) => {
                const other = event.target.value
                update(index, (current) => ({
                  selected: question.multiSelect || !other.trim() ? current.selected : [],
                  other,
                }))
              }}
            />
          </fieldset>
        )
      })}
      <div className="acts">
        <Button variant="primary" type="submit" disabled={!ready}>
          {t("chat.question.submit")}
        </Button>
      </div>
    </form>
  )
}
