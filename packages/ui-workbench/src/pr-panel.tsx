/** PR 面板：展示当前分支的 PR 状态，并在没有 PR 时提供创建表单。 */
import { useState, type FormEvent } from "react"
import type { PullRequestInfo } from "@pigcode/contracts"
import { GitPullRequest, Loader2 } from "lucide-react"
import {
  Badge,
  Button,
  EmptyState,
  ErrorNotice,
  Input,
  Textarea,
  useLocale,
  type BadgeVariant,
  type HostErrorInfo,
} from "@pigcode/ui-primitives"

/** 创建 PR 的输入；body/base 省略时由 Host 使用 gh 默认值。 */
export interface PrCreateInput {
  title: string
  body?: string
  base?: string
}

/** PR 面板属性；所有 RPC 由父组件完成。 */
export interface PrPanelProps {
  pullRequest: PullRequestInfo | null
  onCreate: (input: PrCreateInput) => void | Promise<void>
  creating?: boolean
  loading?: boolean
  /** 查询或创建失败；gh 未安装、未登录、没有远程仓库这些错误显示当前语言的说明。 */
  error?: HostErrorInfo | null
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
}: PrPanelProps) {
  const { t } = useLocale()
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
      {loading ? (
        <EmptyState icon={<Loader2 className="ic spin" />} title={t("pr.loading")} />
      ) : null}
      {error ? <ErrorNotice className="workbench-error" error={error} /> : null}
      {pullRequest ? (
        <section className="pr-card" aria-label={t("pr.card")}>
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
          <EmptyState
            icon={<GitPullRequest className="ic" />}
            title={t("pr.empty")}
            description={t("pr.emptyHint")}
          />
          <form className="pr-form" onSubmit={(event) => void submit(event)}>
            <label className="pr-field">
              <span>{t("pr.title")}</span>
              <Input
                value={title}
                placeholder={t("pr.titlePlaceholder")}
                disabled={creating}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="pr-field">
              <span>{t("pr.body")}</span>
              <Textarea
                value={body}
                placeholder={t("pr.bodyPlaceholder")}
                disabled={creating}
                rows={3}
                onChange={(event) => setBody(event.target.value)}
              />
            </label>
            <label className="pr-field">
              <span>{t("pr.base")}</span>
              <Input
                value={base}
                placeholder={t("pr.basePlaceholder")}
                disabled={creating}
                onChange={(event) => setBase(event.target.value)}
              />
            </label>
            <Button type="submit" size="sm" disabled={creating || trimmedTitle.length === 0}>
              {creating ? t("pr.creating") : t("pr.create")}
            </Button>
          </form>
        </>
      )}
    </div>
  )
}
