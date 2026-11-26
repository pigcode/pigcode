/** PR 面板：展示当前分支的 PR 状态、创建 PR（支持 Draft），并提供 Ready、合并、评论与关闭/重开操作。 */
import { useState, type FormEvent } from "react"
import type { PullRequestInfo } from "@pigcode/contracts"
import { Check, ChevronDown, GitPullRequest, Loader2 } from "lucide-react"
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorNotice,
  Input,
  Select,
  Textarea,
  useLocale,
  type BadgeVariant,
  type HostErrorInfo,
  type MessageKey,
} from "@pigcode/ui-primitives"

/** 创建 PR 的输入；body/base 省略时由 Host 使用 gh 默认值。 */
export interface PrCreateInput {
  title: string
  body?: string
  base?: string
  draft?: boolean
}

/** 合并 PR 的策略。 */
export type PrMergeMethod = "merge" | "squash" | "rebase"

/** 合并 PR 的输入。 */
export interface PrMergeInput {
  method: PrMergeMethod
  deleteBranch?: boolean
}

/** 当前正在执行的 PR 写操作类型。 */
export type PrBusyAction = "create" | "comment" | "merge" | "ready" | "close" | "reopen"

/** PR 面板属性；所有 RPC 由父组件完成。 */
export interface PrPanelProps {
  pullRequest: PullRequestInfo | null
  onCreate: (input: PrCreateInput) => void | Promise<void>
  onComment?: (body: string) => void | Promise<void>
  onMerge?: (input: PrMergeInput) => void | Promise<void>
  onReady?: () => void | Promise<void>
  onClose?: () => void | Promise<void>
  onReopen?: () => void | Promise<void>
  creating?: boolean
  busyAction?: PrBusyAction | null
  loading?: boolean
  /** 查询或写操作失败；gh 未安装、未登录、没有远程仓库这些错误显示当前语言的说明。 */
  error?: HostErrorInfo | null
}

/** PR 状态对应的徽标颜色。 */
const STATE_VARIANTS: Record<PullRequestInfo["state"], BadgeVariant> = {
  OPEN: "ok",
  CLOSED: "bad",
  MERGED: "info",
}

const MERGE_METHOD_LABELS: Record<PrMergeMethod, MessageKey> = {
  squash: "pr.merge.squash",
  merge: "pr.merge.merge",
  rebase: "pr.merge.rebase",
}

/** PR 面板入口；已有 PR 时展示状态卡与操作区，否则展示空状态与创建表单。 */
export function PrPanel({
  pullRequest,
  onCreate,
  onComment,
  onMerge,
  onReady,
  onClose,
  onReopen,
  creating = false,
  busyAction = null,
  loading = false,
  error = null,
}: PrPanelProps) {
  const { t } = useLocale()
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [base, setBase] = useState("")
  const [draft, setDraft] = useState(false)

  const [mergeMethod, setMergeMethod] = useState<PrMergeMethod>("squash")
  const [deleteBranch, setDeleteBranch] = useState(false)
  const [confirmingAction, setConfirmingAction] = useState<"merge" | "close" | null>(null)

  const [commentBody, setCommentBody] = useState("")
  const [commentSent, setCommentSent] = useState(false)

  const trimmedTitle = title.trim()
  const trimmedComment = commentBody.trim()
  const isCreating = creating || busyAction === "create"
  const isActing = isCreating || busyAction !== null

  /** 提交创建表单；失败时保留输入，错误由父组件通过 error 展示。 */
  async function submitCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (trimmedTitle.length === 0 || isActing) return

    const input: PrCreateInput = { title: trimmedTitle }
    const trimmedBody = body.trim()
    if (trimmedBody.length > 0) input.body = trimmedBody
    const trimmedBase = base.trim()
    if (trimmedBase.length > 0) input.base = trimmedBase
    if (draft) input.draft = true

    try {
      await onCreate(input)
      setTitle("")
      setBody("")
      setBase("")
      setDraft(false)
    } catch {
      // 错误由父组件的 error 属性展示，这里只保留用户输入。
    }
  }

  /** 提交评论；成功清空输入框，失败保留输入。 */
  async function submitComment(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!onComment || trimmedComment.length === 0 || isActing) return
    setCommentSent(false)
    try {
      await onComment(trimmedComment)
      setCommentBody("")
      setCommentSent(true)
    } catch {
      // 错误由父组件的 error 属性展示。
    }
  }

  async function handleReady(): Promise<void> {
    if (!onReady || isActing) return
    setConfirmingAction(null)
    try {
      await onReady()
    } catch {
      // 错误由父组件展示。
    }
  }

  async function handleMerge(): Promise<void> {
    if (!onMerge || isActing) return
    try {
      await onMerge({
        method: mergeMethod,
        ...(deleteBranch ? { deleteBranch: true } : {}),
      })
      setConfirmingAction(null)
    } catch {
      // 失败时复位确认行，保留操作面板。
    }
  }

  async function handleClose(): Promise<void> {
    if (!onClose || isActing) return
    try {
      await onClose()
      setConfirmingAction(null)
    } catch {
      // 错误由父组件展示。
    }
  }

  async function handleReopen(): Promise<void> {
    if (!onReopen || isActing) return
    setConfirmingAction(null)
    try {
      await onReopen()
    } catch {
      // 错误由父组件展示。
    }
  }

  const isOpen = pullRequest?.state === "OPEN"
  const isDraftPr = isOpen && pullRequest.isDraft === true
  const showActions =
    pullRequest !== null &&
    ((isOpen && ((isDraftPr && onReady) || (!isDraftPr && onMerge) || onClose)) ||
      (pullRequest.state === "CLOSED" && onReopen))

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
            <Badge variant={isDraftPr ? "warn" : STATE_VARIANTS[pullRequest.state]}>
              {isDraftPr ? t("pr.draft") : pullRequest.state}
            </Badge>
          </header>
          <p className="pr-title">{pullRequest.title}</p>
          <p className="pr-branches">
            {pullRequest.headRefName} → {pullRequest.baseRefName}
          </p>
          <a className="pr-link" href={pullRequest.url} target="_blank" rel="noopener noreferrer">
            {pullRequest.url}
          </a>

          {showActions ? (
            <div className="pr-actions">
              {isOpen && isDraftPr && onReady ? (
                <div className="pr-action-row">
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    disabled={isActing}
                    onClick={() => void handleReady()}
                  >
                    {busyAction === "ready" ? t("pr.readying") : t("pr.ready")}
                  </Button>
                </div>
              ) : null}

              {isOpen && !isDraftPr && onMerge ? (
                <div className="pr-merge-box">
                  <div className="pr-merge-controls">
                    <Select.Root
                      value={mergeMethod}
                      disabled={isActing}
                      onValueChange={(value) => {
                        if (value === "squash" || value === "merge" || value === "rebase") {
                          setMergeMethod(value)
                        }
                      }}
                    >
                      <Select.Trigger
                        className="input select-trigger pr-merge-select"
                        data-size="sm"
                        aria-label={t("pr.mergeMethod")}
                      >
                        <Select.Value className="grow truncate">
                          {(value: PrMergeMethod) => t(MERGE_METHOD_LABELS[value])}
                        </Select.Value>
                        <ChevronDown className="ic ic-sm" aria-hidden="true" />
                      </Select.Trigger>
                      <Select.Portal>
                        <Select.Positioner sideOffset={6} alignItemWithTrigger={false}>
                          <Select.Popup>
                            {(["squash", "merge", "rebase"] as const).map((method) => (
                              <Select.Item key={method} value={method}>
                                <Select.ItemText>{t(MERGE_METHOD_LABELS[method])}</Select.ItemText>
                              </Select.Item>
                            ))}
                          </Select.Popup>
                        </Select.Positioner>
                      </Select.Portal>
                    </Select.Root>
                    <label className="pr-check-row">
                      <Checkbox.Root
                        checked={deleteBranch}
                        disabled={isActing}
                        onCheckedChange={(checked) => setDeleteBranch(checked === true)}
                      >
                        <Checkbox.Indicator>
                          <Check className="ic ic-xs" aria-hidden="true" />
                        </Checkbox.Indicator>
                      </Checkbox.Root>
                      <span>{t("pr.mergeDeleteBranch")}</span>
                    </label>
                  </div>
                  {confirmingAction === "merge" ? (
                    <div className="pr-confirm-row">
                      <span className="pr-confirm-text">{t("pr.mergeConfirm")}</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        disabled={isActing}
                        onClick={() => void handleMerge()}
                      >
                        {busyAction === "merge" ? t("pr.merging") : t("pr.confirmMerge")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={isActing}
                        onClick={() => setConfirmingAction(null)}
                      >
                        {t("common.cancel")}
                      </Button>
                    </div>
                  ) : (
                    <div className="pr-action-row">
                      <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        disabled={isActing}
                        onClick={() => setConfirmingAction("merge")}
                      >
                        {t("pr.merge")}
                      </Button>
                    </div>
                  )}
                </div>
              ) : null}

              {isOpen && onClose ? (
                confirmingAction === "close" ? (
                  <div className="pr-confirm-row">
                    <span className="pr-confirm-text">{t("pr.closeConfirm")}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="solidDanger"
                      disabled={isActing}
                      onClick={() => void handleClose()}
                    >
                      {busyAction === "close" ? t("pr.closing") : t("pr.confirmClose")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={isActing}
                      onClick={() => setConfirmingAction(null)}
                    >
                      {t("common.cancel")}
                    </Button>
                  </div>
                ) : (
                  <div className="pr-action-row">
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      disabled={isActing}
                      onClick={() => setConfirmingAction("close")}
                    >
                      {t("pr.close")}
                    </Button>
                  </div>
                )
              ) : null}

              {pullRequest.state === "CLOSED" && onReopen ? (
                <div className="pr-action-row">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={isActing}
                    onClick={() => void handleReopen()}
                  >
                    {busyAction === "reopen" ? t("pr.reopening") : t("pr.reopen")}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {onComment ? (
            <form className="pr-comment-form" onSubmit={(event) => void submitComment(event)}>
              <label className="pr-field">
                <span>{t("pr.comment")}</span>
                <Textarea
                  size="lg"
                  value={commentBody}
                  placeholder={t("pr.commentPlaceholder")}
                  disabled={isActing}
                  rows={2}
                  onChange={(event) => {
                    setCommentBody(event.target.value)
                    if (commentSent) setCommentSent(false)
                  }}
                />
              </label>
              <div className="pr-comment-footer">
                {commentSent ? (
                  <span className="pr-comment-sent">{t("pr.commentSent")}</span>
                ) : null}
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  disabled={isActing || trimmedComment.length === 0}
                >
                  {busyAction === "comment" ? t("pr.commentSending") : t("pr.commentSend")}
                </Button>
              </div>
            </form>
          ) : null}
        </section>
      ) : loading ? null : (
        <>
          <EmptyState
            icon={<GitPullRequest className="ic" />}
            title={t("pr.empty")}
            description={t("pr.emptyHint")}
          />
          <form className="pr-form" onSubmit={(event) => void submitCreate(event)}>
            <label className="pr-field">
              <span>{t("pr.title")}</span>
              <Input
                size="lg"
                value={title}
                placeholder={t("pr.titlePlaceholder")}
                disabled={isActing}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="pr-field">
              <span>{t("pr.body")}</span>
              <Textarea
                size="lg"
                value={body}
                placeholder={t("pr.bodyPlaceholder")}
                disabled={isActing}
                rows={3}
                onChange={(event) => setBody(event.target.value)}
              />
            </label>
            <label className="pr-field">
              <span>{t("pr.base")}</span>
              <Input
                size="lg"
                value={base}
                placeholder={t("pr.basePlaceholder")}
                disabled={isActing}
                onChange={(event) => setBase(event.target.value)}
              />
            </label>
            <label className="pr-check-row">
              <Checkbox.Root
                checked={draft}
                disabled={isActing}
                onCheckedChange={(checked) => setDraft(checked === true)}
              >
                <Checkbox.Indicator>
                  <Check className="ic ic-xs" aria-hidden="true" />
                </Checkbox.Indicator>
              </Checkbox.Root>
              <span>{t("pr.createAsDraft")}</span>
            </label>
            <Button
              type="submit"
              size="lg"
              variant="primary"
              disabled={isActing || trimmedTitle.length === 0}
            >
              {isCreating ? t("pr.creating") : t("pr.create")}
            </Button>
          </form>
        </>
      )}
    </div>
  )
}
