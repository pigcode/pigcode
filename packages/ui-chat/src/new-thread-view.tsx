/**
 * 新会话草稿页（参照 ZCode 的新建任务）：按时段的问候，下面是输入框，卡片上方一条选择项目，
 * 输入框下方几条建议，点一下预填进输入框。草稿还不是会话，侧栏里也没有它；第一次发送时容器才建会话。
 * 版式、问候、项目条与建议也给还没有消息的会话用（chat-view.tsx），两处长得一样。
 */
import { useEffect, useState, type ReactNode } from "react"
import {
  BookOpen,
  Bug,
  Check,
  ChevronDown,
  FlaskConical,
  Folder,
  FolderPlus,
  ScanSearch,
  type LucideIcon,
} from "lucide-react"
import {
  Composer,
  prefillComposer,
  type ComposerAgent,
  type ComposerCommand,
  type ComposerModelCatalog,
  type ComposerModelChoice,
  type ComposerProps,
  type ComposerSubmitOptions,
  type PermissionMode,
} from "@pigcode/ui-composer"
import { Menu, useLocale, type MessageKey } from "@pigcode/ui-primitives"

/** 草稿可以落到的项目。 */
export interface NewThreadProject {
  id: string
  name: string
  rootPath: string
}

/** 草稿页的属性；agent、模型、权限与项目都由容器保管，发送时容器建会话。 */
export interface NewThreadViewProps {
  projects: readonly NewThreadProject[]
  /** 草稿要落到的项目；null 表示还没有项目。 */
  projectId: string | null
  onSelectProject: (projectId: string) => void
  onAddProject: () => void
  /** 输入框的草稿键；建议预填到这里。 */
  draftKey: string
  agents?: readonly ComposerAgent[]
  catalog?: ComposerModelCatalog
  onLoadModels?: (instanceId: string) => void
  /** 当前选中的实例 id；默认实例等于 agent id。 */
  agentId: string | null
  modelId: string | null
  /** 选中某个实例的模型；容器据此记下草稿的实例与模型。 */
  onSelectModel: (choice: ComposerModelChoice) => void
  permissionMode: PermissionMode
  onPermissionMode: (mode: PermissionMode) => void
  canPlan?: boolean
  /** @ 引用时可选的项目文件。 */
  files?: () => Promise<readonly string[]>
  commands?: readonly ComposerCommand[]
  /** 读 Agent 实例的 / 命令与 skill；容器应调用 agent.commands（带项目）并缓存。 */
  loadAgentCommands?: ComposerProps["loadAgentCommands"]
  onSubmit: (text: string, options: ComposerSubmitOptions) => void
  /** 正在把草稿建成会话；期间不能再发送。 */
  pending?: boolean
  /** 每次变化都把光标放回输入框，例如在草稿里再按一次新会话。 */
  focusKey?: number
  /** 顶栏右侧「在编辑器中打开项目」的入口，打开的是草稿的项目。 */
  openIn?: ReactNode
  /** 顶栏右侧的布局按钮。 */
  layoutControls?: ReactNode
}

const SUGGESTIONS: ReadonlyArray<{
  id: string
  icon: LucideIcon
  label: MessageKey
  prompt: MessageKey
}> = [
  {
    id: "explain",
    icon: BookOpen,
    label: "newThread.suggest.explain",
    prompt: "newThread.suggest.explain.prompt",
  },
  { id: "fix", icon: Bug, label: "newThread.suggest.fix", prompt: "newThread.suggest.fix.prompt" },
  {
    id: "test",
    icon: FlaskConical,
    label: "newThread.suggest.test",
    prompt: "newThread.suggest.test.prompt",
  },
  {
    id: "review",
    icon: ScanSearch,
    label: "newThread.suggest.review",
    prompt: "newThread.suggest.review.prompt",
  },
]

/** 各时段从几点开始；凌晨零点到五点仍算深夜。 */
const GREETINGS: ReadonlyArray<readonly [from: number, key: MessageKey]> = [
  [5, "newThread.greeting.morning"],
  [12, "newThread.greeting.noon"],
  [14, "newThread.greeting.afternoon"],
  [18, "newThread.greeting.evening"],
  [23, "newThread.greeting.night"],
]

/** 这个时刻的问候。 */
export function greetingKey(date: Date): MessageKey {
  const hour = date.getHours()
  let key: MessageKey = "newThread.greeting.night"
  for (const [from, candidate] of GREETINGS) if (hour >= from) key = candidate
  return key
}

/** 当前时段的问候；窗口一直开着时，每到整点重新算一次。 */
function useGreeting(): MessageKey {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const next = new Date(now)
    next.setHours(now.getHours() + 1, 0, 0, 0)
    const timer = window.setTimeout(() => setNow(new Date()), next.getTime() - now.getTime())
    return () => window.clearTimeout(timer)
  }, [now])
  return greetingKey(now)
}

/** 问候后面的大号 Pigcode 标志，只是装饰：线条很淡，往下渐隐。 */
function PigcodeMark() {
  return (
    <svg className="new-thread-mark" viewBox="2.5 5.5 19 13.5" aria-hidden="true">
      <rect x="3" y="6" width="18" height="12.5" rx="6.25" />
      <path d="M9.5 10.3v3.9M14.5 10.3v3.9" />
    </svg>
  )
}

/** 问候、输入框与建议排成一列，在内容区里竖直居中。 */
export function NewThreadStage({ children }: { children: ReactNode }) {
  return (
    <div className="new-thread">
      <div className="new-thread-body">{children}</div>
    </div>
  )
}

/** 输入框上方的问候；不给 title 时按时段问候，children 接在说明后面。 */
export function NewThreadHero({
  title,
  hint,
  children,
}: {
  title?: string | undefined
  hint?: string | undefined
  children?: ReactNode
}) {
  const { t } = useLocale()
  const greeting = t(useGreeting())
  return (
    <div className="new-thread-hero">
      <PigcodeMark />
      <h1 className="new-thread-title">
        {title ?? t("newThread.title").replace("{greeting}", greeting)}
      </h1>
      {hint ? <p className="new-thread-hint">{hint}</p> : null}
      {children}
    </div>
  )
}

/** 输入框下方的建议：点一下把提示预填进 draftKey 的输入框，不发送。 */
export function NewThreadSuggestions({
  draftKey,
  disabled = false,
}: {
  draftKey: string
  disabled?: boolean | undefined
}) {
  const { t } = useLocale()
  return (
    <div className="new-thread-suggestions" role="group" aria-label={t("newThread.suggestions")}>
      {SUGGESTIONS.map(({ id, icon: Icon, label, prompt }) => (
        <button
          key={id}
          type="button"
          className="suggest-chip"
          disabled={disabled}
          onClick={() => prefillComposer(draftKey, { text: t(prompt) })}
        >
          <Icon className="ic ic-sm" aria-hidden="true" />
          {t(label)}
        </button>
      ))}
    </div>
  )
}

/** 卡片上方的项目，已经建好的会话用：会话属于这个项目，只显示，不能换。 */
export function ProjectChip({ name, rootPath }: { name: string; rootPath?: string | undefined }) {
  const { t } = useLocale()
  return (
    <span className="chip-btn draft-project" data-static="" title={rootPath}>
      <Folder className="ic" aria-hidden="true" />
      <span className="sr-only">{`${t("newThread.project")}: `}</span>
      <span className="truncate">{name}</span>
    </span>
  )
}

/** 卡片上方的项目选择；还没有项目时直接是「添加项目」。 */
function ProjectMenu({
  projects,
  projectId,
  onSelect,
  onAdd,
}: {
  projects: readonly NewThreadProject[]
  projectId: string | null
  onSelect: (projectId: string) => void
  onAdd: () => void
}) {
  const { t } = useLocale()
  const current = projects.find((project) => project.id === projectId)
  if (projects.length === 0) {
    return (
      <button type="button" className="chip-btn draft-project" onClick={onAdd}>
        <FolderPlus className="ic" aria-hidden="true" />
        <span>{t("nav.addProject")}</span>
      </button>
    )
  }
  const label = current?.name ?? t("newThread.pickProject")
  return (
    <Menu.Root>
      <Menu.Trigger
        className="chip-btn draft-project"
        type="button"
        aria-label={`${t("newThread.project")}: ${label}`}
        title={current?.rootPath}
      >
        <Folder className="ic" aria-hidden="true" />
        <span className="truncate">{label}</span>
        <ChevronDown className="ic chip-caret" aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={6}>
          <Menu.Popup className="draft-project-menu">
            <Menu.Group>
              <Menu.Label>{t("nav.projects")}</Menu.Label>
              {projects.map((project) => (
                <Menu.Item
                  key={project.id}
                  data-project={project.id}
                  onClick={() => onSelect(project.id)}
                >
                  <Folder className="ic" aria-hidden="true" />
                  <span className="grow">
                    <span className="truncate">{project.name}</span>
                    <span className="menu-item-desc truncate">{project.rootPath}</span>
                  </span>
                  {project.id === projectId ? (
                    <Check className="ic check-mark" aria-hidden="true" />
                  ) : null}
                </Menu.Item>
              ))}
            </Menu.Group>
            <Menu.Separator />
            <Menu.Item onClick={onAdd}>
              <FolderPlus className="ic" aria-hidden="true" />
              <span className="grow">{t("newThread.addProject")}</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

/** 渲染新会话草稿页。 */
export function NewThreadView({
  projects,
  projectId,
  onSelectProject,
  onAddProject,
  draftKey,
  agents = [],
  catalog = {},
  onLoadModels,
  agentId,
  modelId,
  onSelectModel,
  permissionMode,
  onPermissionMode,
  canPlan = true,
  files,
  commands,
  loadAgentCommands,
  onSubmit,
  pending = false,
  focusKey,
  openIn,
  layoutControls,
}: NewThreadViewProps) {
  const { t } = useLocale()
  const ready = projects.some((project) => project.id === projectId)
  return (
    <section className="view new-thread-view" aria-label={t("nav.newThread")}>
      <div className="panel-top">
        <span className="spacer" />
        {ready ? openIn : null}
        {layoutControls}
      </div>
      <NewThreadStage>
        <NewThreadHero hint={ready ? undefined : t("newThread.noProjectHint")} />
        <Composer
          tall
          header={
            <ProjectMenu
              projects={projects}
              projectId={ready ? projectId : null}
              onSelect={onSelectProject}
              onAdd={onAddProject}
            />
          }
          onSubmit={onSubmit}
          onStop={() => undefined}
          disabled={!ready || pending}
          autoFocus={ready}
          focusKey={focusKey}
          draftKey={draftKey}
          agents={agents}
          agentId={agentId}
          modelId={modelId}
          catalog={catalog}
          {...(onLoadModels ? { onLoadModels } : {})}
          onSelectModel={onSelectModel}
          permissionMode={permissionMode}
          onPermissionMode={onPermissionMode}
          canPlan={canPlan}
          {...(files ? { files } : {})}
          {...(commands ? { commands } : {})}
          {...(loadAgentCommands ? { loadAgentCommands } : {})}
        />
        {ready ? <NewThreadSuggestions draftKey={draftKey} disabled={pending} /> : null}
      </NewThreadStage>
    </section>
  )
}
