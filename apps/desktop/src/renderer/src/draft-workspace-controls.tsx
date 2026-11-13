/** 新会话输入框上方的分支与 worktree 控件。 */
import { useEffect, useId, useRef, useState } from "react"
import { Check, ChevronDown, GitBranch, GitBranchPlus, Search } from "lucide-react"
import type { GitBranches, WorktreeStart } from "@pigcode/contracts"
import {
  Autocomplete,
  Button,
  Dialog,
  Input,
  Popover,
  Switch,
  useLocale,
} from "@pigcode/ui-primitives"

interface Props {
  branches: GitBranches | null
  worktree: WorktreeStart | null
  disabled: boolean
  onOpenBranches: () => void
  onSwitchBranch: (branch: string) => void
  onWorktree: (worktree: WorktreeStart | null) => void
  onCreateBranch: (branch: string) => Promise<unknown>
}

export function DraftWorkspaceControls(props: Props) {
  const { t } = useLocale()
  const [creating, setCreating] = useState(false)
  const { branches, worktree, disabled } = props
  const canCreateWorktree = Boolean(
    branches?.head || branches?.localBranches.length || branches?.remoteBranches.length,
  )

  if (!branches) return null

  return (
    <>
      <span className="draft-workspace-divider" aria-hidden="true" />
      <BranchPicker {...props} branches={branches} onCreate={() => setCreating(true)} />
      <label
        className="draft-worktree"
        data-checked={worktree !== null || undefined}
        title={t(canCreateWorktree ? "newThread.worktree.hint" : "newThread.worktree.noCommit")}
      >
        <span>worktree</span>
        <Switch
          checked={worktree !== null}
          disabled={disabled || (!canCreateWorktree && !worktree)}
          onCheckedChange={(checked) => props.onWorktree(checked ? {} : null)}
        />
      </label>
      {creating ? (
        <CreateBranchDialog onSave={props.onCreateBranch} onClose={() => setCreating(false)} />
      ) : null}
    </>
  )
}

const CURRENT_HEAD = "HEAD"

function BranchPicker({
  branches,
  worktree,
  disabled,
  onOpenBranches,
  onSwitchBranch,
  onWorktree,
  onCreate,
}: Pick<Props, "worktree" | "disabled" | "onOpenBranches" | "onSwitchBranch" | "onWorktree"> & {
  branches: GitBranches
  onCreate: () => void
}) {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const detached = t("newThread.branch.detached")
  const currentLabel =
    branches.currentBranch ??
    (branches.head ? `${detached} · ${branches.head.slice(0, 7)}` : detached)
  const selected = worktree
    ? (worktree.baseRef ?? CURRENT_HEAD)
    : `refs/heads/${branches.currentBranch ?? ""}`
  const headLabel = t("newThread.branch.head").replace("{branch}", currentLabel)
  const labelOf = (ref: string) =>
    ref === CURRENT_HEAD ? headLabel : ref.replace(/^refs\/(heads|remotes)\//, "")
  const localBranches = [...branches.localBranches].sort(
    (left, right) =>
      Number(right === branches.currentBranch) - Number(left === branches.currentBranch),
  )
  const groups = [
    ...(worktree && branches.head ? [{ label: "", items: [CURRENT_HEAD] }] : []),
    {
      label: worktree ? t("newThread.branch.local") : "",
      items: localBranches.map((name) => `refs/heads/${name}`),
    },
    ...(worktree
      ? [
          {
            label: t("newThread.branch.remote"),
            items: branches.remoteBranches.map((name) => `refs/remotes/${name}`),
          },
        ]
      : []),
  ].filter((group) => group.items.length > 0)
  const label = worktree?.baseRef
    ? labelOf(worktree.baseRef)
    : worktree && !branches.head
      ? t("newThread.branch.pickBase")
      : currentLabel
  const action = t(worktree ? "newThread.branch.base" : "newThread.branch.switch")

  useEffect(() => {
    if (open)
      list.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" })
  }, [open, selected])

  function pick(ref: string) {
    setOpen(false)
    if (worktree) onWorktree(ref === CURRENT_HEAD ? {} : { baseRef: ref })
    else if (ref !== selected) onSwitchBranch(labelOf(ref))
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) onOpenBranches()
      }}
    >
      <Popover.Trigger
        className="chip-btn draft-branch"
        aria-label={`${action} · ${label}`}
        title={label}
        disabled={disabled}
      >
        <GitBranch className="ic" aria-hidden="true" />
        <span className="truncate draft-branch-label">{label}</span>
        <ChevronDown className="ic chip-caret" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8}>
          <Popover.Popup className="draft-branch-menu" initialFocus={input}>
            {open ? (
              <Autocomplete.Root inline open items={groups} itemToStringValue={labelOf}>
                <div className="draft-branch-search">
                  <Autocomplete.InputGroup className="search-field" data-variant="plain">
                    <Search className="ic" aria-hidden="true" />
                    <Autocomplete.Input
                      ref={input}
                      className="draft-branch-input"
                      type="search"
                      aria-label={t("newThread.branch.search")}
                      placeholder={t("newThread.branch.search")}
                      spellCheck={false}
                    />
                  </Autocomplete.InputGroup>
                </div>
                <Autocomplete.List ref={list} className="draft-branch-list" aria-label={action}>
                  {(group: (typeof groups)[number]) => (
                    <Autocomplete.Group key={group.items[0]} items={group.items}>
                      {group.label ? (
                        <Autocomplete.GroupLabel className="draft-branch-group">
                          {group.label}
                        </Autocomplete.GroupLabel>
                      ) : null}
                      <Autocomplete.Collection>
                        {(ref: string) => (
                          <Autocomplete.Item
                            key={ref}
                            className="draft-branch-option"
                            value={ref}
                            aria-current={selected === ref}
                            aria-label={labelOf(ref)}
                            onClick={() => pick(ref)}
                          >
                            <span className="draft-branch-check" aria-hidden="true">
                              {selected === ref ? <Check className="ic ic-sm" /> : null}
                            </span>
                            <span className="grow truncate draft-branch-name" title={labelOf(ref)}>
                              {labelOf(ref)}
                            </span>
                            {ref === `refs/heads/${branches.currentBranch}` ? (
                              <span className="draft-branch-current">
                                {t("newThread.branch.current")}
                              </span>
                            ) : null}
                          </Autocomplete.Item>
                        )}
                      </Autocomplete.Collection>
                    </Autocomplete.Group>
                  )}
                </Autocomplete.List>
                <Autocomplete.Empty className="draft-branch-empty">
                  {t("newThread.branch.empty")}
                </Autocomplete.Empty>
              </Autocomplete.Root>
            ) : null}
            {worktree ? (
              <p className="draft-branch-note">{t("newThread.worktree.baseHint")}</p>
            ) : (
              <div className="draft-branch-footer">
                <button
                  type="button"
                  className="menu-item draft-branch-create"
                  onClick={() => {
                    setOpen(false)
                    onCreate()
                  }}
                >
                  <GitBranchPlus className="ic ic-sm" aria-hidden="true" />
                  {t("newThread.branch.create")}
                </button>
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function CreateBranchDialog({
  onSave,
  onClose,
}: {
  onSave: (name: string) => Promise<unknown>
  onClose: () => void
}) {
  const { t } = useLocale()
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const action = t("newThread.branch.create")

  async function save() {
    const value = name.trim()
    if (saving || !value) return
    setSaving(true)
    setError(null)
    try {
      await onSave(value)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setSaving(false)
    }
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <Dialog.Content
        title={action}
        description={t("newThread.branch.createHint")}
        closeLabel={t("common.close")}
        closeDisabled={saving}
        initialFocus={input}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <Dialog.Body>
            <div className="field">
              <label htmlFor={id}>{t("newThread.branch.name")}</label>
              <Input
                id={id}
                ref={input}
                value={name}
                spellCheck={false}
                maxLength={240}
                placeholder={t("newThread.branch.namePlaceholder")}
                disabled={saving}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            {error ? (
              <p role="alert" className="error-text">
                {error}
              </p>
            ) : null}
          </Dialog.Body>
          <Dialog.Footer>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={saving || !name.trim()}>
              {action}
            </Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  )
}
