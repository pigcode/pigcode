/** PR 面板：展示当前分支的 PR 状态，并在没有 PR 时提供创建表单。 */
import { useState, type FormEvent } from "react"
import type { PullRequestInfo } from "@pigcode/contracts"
import { Badge, Button, Input, Textarea, type BadgeVariant } from "@pigcode/ui-primitives"

/** 创建 PR 的输入；body/base 省略时由 Host 使用 gh 默认值。 */
export interface PrCreateInput {
  title: string
  body?: string
  base?: string
}

/** PR 面板文案；容器按当前 locale 注入，组件本身保持无 locale 依赖。 */
export interface PrPanelLabels {
  empty: string
  loading: string
  title: string
  titlePlaceholder: string
  body: string
  bodyPlaceholder: string
  base: string
  basePlaceholder: string
  create: string
  creating: string
}

/** 默认中文文案；未注入 labels 时使用。 */
export const DEFAULT_PR_LABELS: PrPanelLabels = {
  empty: "还没有关联的 Pull Request",
  loading: "正在查询 Pull Request…",
  title: "标题",
  titlePlaceholder: "Pull Request 标题",
  body: "描述",
  bodyPlaceholder: "可选：说明改动",
  base: "目标分支",
  basePlaceholder: "main",
  create: "创建 PR",
  creating: "正在创建…",
}

/** PR 面板属性；所有 RPC 由父组件完成。 */
export interface PrPanelProps {
  pullRequest: PullRequestInfo | null
  onCreate: (input: PrCreateInput) => void | Promise<void>
  creating?: boolean
  loading?: boolean
  error?: string | null
  labels?: Partial<PrPanelLabels>
}

/** PR 状态对应的徽标颜色。 */
const STATE_VARIANTS: Record<PullRequestInfo["state"], BadgeVariant> = {
  OPEN: "ok",
  CLOSED: "bad",
  MERGED: "info",
}

/** PR 面板入口；已有 PR 时展示状态卡，否则展示空状态与创建表单。 */
export function PrPanel({
  pullRequest,
  onCreate,
  creating = false,
  loading = false,
  error = null,
  labels: overrides,
}: PrPanelProps) {
  const labels: PrPanelLabels = { ...DEFAULT_PR_LABELS, ...overrides }
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [base, setBase] = useState("")
  const trimmedTitle = title.trim()

  /** 提交创建表单；失败时保留输入，错误由父组件通过 error 展示。 */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (trimmedTitle.length === 0 || creating) return

    const input: PrCreateInput = { title: trimmedTitle }
    const trimmedBody = body.trim()
    if (trimmedBody.length > 0) input.body = trimmedBody
    const trimmedBase = base.trim()
    if (trimmedBase.length > 0) input.base = trimmedBase

    try {
      await onCreate(input)
      setTitle("")
      setBody("")
      setBase("")
    } catch {
      // 错误由父组件的 error 属性展示，这里只保留用户输入。
    }
  }

  return (
    <div className="pr-panel">
      {loading ? <p className="workbench-empty">{labels.loading}</p> : null}
      {error ? <p className="workbench-error">{error}</p> : null}
      {pullRequest ? (
        <section className="pr-card" aria-label="Pull request">
          <header className="pr-card-header">
            <span className="pr-number">#{pullRequest.number}</span>
            <Badge variant={STATE_VARIANTS[pullRequest.state]}>{pullRequest.state}</Badge>
          </header>
          <p className="pr-title">{pullRequest.title}</p>
          <p className="pr-branches">
            {pullRequest.headRefName} → {pullRequest.baseRefName}
          </p>
          <a className="pr-link" href={pullRequest.url} target="_blank" rel="noopener noreferrer">
            {pullRequest.url}
          </a>
        </section>
      ) : loading ? null : (
        <>
          <p className="workbench-empty">{labels.empty}</p>
          <form className="pr-form" onSubmit={(event) => void submit(event)}>
            <label className="pr-field">
              <span>{labels.title}</span>
              <Input
                value={title}
                placeholder={labels.titlePlaceholder}
                disabled={creating}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="pr-field">
              <span>{labels.body}</span>
              <Textarea
                value={body}
                placeholder={labels.bodyPlaceholder}
                disabled={creating}
                rows={3}
                onChange={(event) => setBody(event.target.value)}
              />
            </label>
            <label className="pr-field">
              <span>{labels.base}</span>
              <Input
                value={base}
                placeholder={labels.basePlaceholder}
                disabled={creating}
                onChange={(event) => setBase(event.target.value)}
              />
            </label>
            <Button type="submit" size="sm" disabled={creating || trimmedTitle.length === 0}>
              {creating ? labels.creating : labels.create}
            </Button>
          </form>
        </>
      )}
    </div>
  )
}
