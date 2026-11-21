/**
 * 方案 D「对话优先 + 桌面式菜单」：在 C 的基础上按用户给的元宝截图定的。主界面是会话页，左上角拉出侧边菜单；
 * 菜单照桌面侧栏排：新会话、置顶、按项目（可以换成按更新时间或按状态）分组的会话，底下是电脑和设置。
 * 菜单拉出来时会话页往右推、露出一条边；长按会话（电脑浏览器里右键）可以置顶、标为已读、归档。
 */
import { useRef, useState, type ReactNode } from "react"
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  FileDiff,
  Folder,
  FolderOpen,
  Laptop,
  Mail,
  MailOpen,
  Menu,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  SquarePen,
} from "lucide-react"
import { StatusDot, Switch } from "@pigcode/ui-primitives"
import {
  ApprovalBody,
  Composer,
  ComputerDetails,
  ConnLabel,
  DiffScreen,
  IconButton,
  PairingFlow,
  PickerSheet,
  PlanList,
  QuestionBody,
  RowBadge,
  Sheet,
  Timeline,
  useNewThreadForm,
  useOpenThread,
} from "./common"
import { COMPUTER, PROJECTS, project, type Group } from "./data"
import { useNav } from "./nav"
import { CATEGORIES, useProto, type Arrangement, type Category } from "./store"
import { CActivity } from "./variant-c"

const DEFAULT_THREAD = "t-running"
const GROUPS: Group[] = ["今天", "昨天", "更早"]

const STATUS_SECTIONS: Array<{ key: string; label: string; categories: Category[] }> = [
  { key: "attention", label: "需要处理", categories: ["attention", "unread"] },
  { key: "error", label: "出错", categories: ["error"] },
  { key: "working", label: "进行中", categories: ["working"] },
  { key: "done", label: "已完成", categories: ["done"] },
]

interface Section {
  key: string
  label: string
  ids: string[]
  projectId?: string | undefined
}

export function VariantD() {
  const nav = useNav()
  const store = useProto()
  const { place } = nav
  const [customize, setCustomize] = useState(false)
  const [settings, setSettings] = useState(false)
  const [actionsFor, setActionsFor] = useState<string | null>(null)
  const current = place.thread ?? DEFAULT_THREAD

  if (place.screen === "diff" && place.thread) {
    return <DiffScreen id={place.thread} file={place.file} onBack={() => nav.back({ screen: "thread", thread: place.thread })} />
  }
  if (place.screen === "pair") {
    return (
      <div className="m-screen">
        <PairingFlow onDone={() => nav.replace({ screen: "thread", thread: current })} onCancel={() => nav.back({ screen: "thread", thread: current })} />
      </div>
    )
  }

  const drawerOpen = place.screen === "list" || place.screen === "inbox"

  return (
    <div className="m-screen v-d" data-drawer={drawerOpen || undefined}>
      <DDrawer
        current={place.screen === "new" ? undefined : current}
        onCustomize={() => setCustomize(true)}
        onSettings={() => setSettings(true)}
        onActions={setActionsFor}
      />
      <div className="d-page">
        {place.screen === "new" ? <DNew key={place.project ?? "default"} /> : <DThread id={current} />}
        {drawerOpen ? (
          <button type="button" className="d-cover" aria-label="收起菜单" onClick={() => nav.replace({ screen: "thread", thread: current })} />
        ) : null}
      </div>
      <Sheet open={customize} title="分组和筛选" onClose={() => setCustomize(false)}>
        <DCustomize />
      </Sheet>
      <Sheet open={Boolean(actionsFor)} title={actionsFor ? store.meta[actionsFor]?.title : undefined} onClose={() => setActionsFor(null)}>
        {actionsFor ? <DActions id={actionsFor} onDone={() => setActionsFor(null)} /> : null}
      </Sheet>
      <Sheet open={settings} title="设置" onClose={() => setSettings(false)}>
        <DSettings
          onComputer={() => {
            setSettings(false)
            nav.go({ screen: "computer", thread: current })
          }}
        />
      </Sheet>
      <Sheet open={place.screen === "computer"} title="电脑" onClose={() => nav.back({ screen: "thread", thread: current })}>
        <ComputerDetails onPair={() => nav.go({ screen: "pair", thread: current })} />
      </Sheet>
    </div>
  )
}

// ─── 会话页 ──────────────────────────────────────────────

function DHeader({ title, sub, files, onDiff }: { title: string; sub: ReactNode; files: number; onDiff?: () => void }) {
  const store = useProto()
  const nav = useNav()
  const { attention } = store.counts()
  return (
    <header className="d-head">
      <button type="button" className="d-round" aria-label="会话菜单" onClick={() => nav.go({ screen: "list", thread: nav.place.thread })}>
        <Menu className="ic" aria-hidden="true" />
        {attention > 0 && store.conn !== "offline" ? <span className="c-menu-dot" /> : null}
      </button>
      <div className="d-title">
        <span className="d-title-main">{title}</span>
        <span className="d-title-sub">{sub}</span>
      </div>
      <div className="d-capsule">
        {onDiff ? (
          <button type="button" aria-label="改动" disabled={files === 0} onClick={onDiff}>
            <FileDiff className="ic" aria-hidden="true" />
            {files > 0 ? <span>{files}</span> : null}
          </button>
        ) : null}
        <button type="button" aria-label="新会话" onClick={() => nav.go({ screen: "new" })}>
          <SquarePen className="ic" aria-hidden="true" />
        </button>
      </div>
    </header>
  )
}

function DThread({ id }: { id: string }) {
  useOpenThread(id)
  const store = useProto()
  const nav = useNav()
  const [planOpen, setPlanOpen] = useState(false)
  const meta = store.meta[id]
  if (!meta) return null
  const state = store.stateOf(id)
  const approval = store.pendingApproval(id)
  const question = store.pendingQuestion(id)
  const plan = store.plans[id]

  const sub =
    store.conn !== "online" ? (
      <ConnLabel conn={store.conn} />
    ) : state === "approval" ? (
      <span className="c-warn">等你确认</span>
    ) : state === "question" ? (
      <span className="c-warn">等你回答</span>
    ) : state === "running" ? (
      <>
        <StatusDot tone="running" />
        生成中
      </>
    ) : (
      <>
        {project(meta.projectId).name} · {meta.agent}
      </>
    )

  return (
    <>
      <DHeader title={meta.title} sub={sub} files={store.files(id).length} onDiff={() => nav.go({ screen: "diff", thread: id })} />
      <Timeline id={id} className="c-hide-inline" onViewDiff={(path) => nav.go({ screen: "diff", thread: id, file: path })} />
      <div className="m-dock">
        {approval ? (
          <div className="c-panel">
            <ApprovalBody approval={approval} onDecide={(decision) => store.resolveApproval(id, approval.requestId, decision)} />
          </div>
        ) : question ? (
          <div className="c-panel">
            <QuestionBody question={question} onAnswer={(answers) => store.answerQuestion(id, question.requestId, answers)} />
          </div>
        ) : (
          <>
            {state === "running" ? <CActivity id={id} onOpen={() => setPlanOpen(true)} /> : null}
            <Composer id={id} placeholder={state === "running" ? "生成中 · 发出的消息会排队" : undefined} />
          </>
        )}
      </div>
      <Sheet open={planOpen} title="这一轮" onClose={() => setPlanOpen(false)}>
        {plan ? <PlanList items={plan} /> : <p className="m-note">这一轮没有计划。</p>}
      </Sheet>
    </>
  )
}

function DNew() {
  const nav = useNav()
  const form = useNewThreadForm(nav.place.project ?? "pigcode")
  return (
    <>
      <DHeader title="新会话" sub={form.project.name} files={0} />
      <div className="c-new">
        <h1>做点什么？</h1>
      </div>
      <div className="m-dock">
        <div className="c-chips">
          <button type="button" className="m-chip" onClick={() => form.setPicker("project")}>
            <Folder className="ic" aria-hidden="true" />
            {form.project.name}
            <ChevronDown className="ic" aria-hidden="true" />
          </button>
          <button type="button" className="m-chip" onClick={() => form.setPicker("agent")}>
            {form.agent.name}
            <ChevronDown className="ic" aria-hidden="true" />
          </button>
          <button type="button" className="m-chip" onClick={() => form.setPicker("permission")}>
            {form.permission}
            <ChevronDown className="ic" aria-hidden="true" />
          </button>
        </div>
        <Composer
          id="new"
          placeholder="描述要做的事"
          onSend={form.submit}
          footer={
            <div className="m-composer-foot">
              <button type="button" className="m-chip m-chip-quiet" onClick={() => form.setPicker("model")}>
                {form.model}
                <ChevronDown className="ic" aria-hidden="true" />
              </button>
            </div>
          }
        />
      </div>
      <PickerSheet form={form} />
    </>
  )
}

// ─── 侧边菜单 ────────────────────────────────────────────

function useSections(ids: readonly string[], searching: boolean): Section[] {
  const store = useProto()
  const { grouping } = store.arrangement
  if (grouping === "project") {
    const narrowed = searching || store.filtersActive()
    return PROJECTS.map((item) => ({
      key: item.id,
      label: item.name,
      projectId: item.id,
      ids: ids.filter((id) => store.meta[id]?.projectId === item.id),
    })).filter((section) => !narrowed || section.ids.length > 0)
  }
  if (grouping === "time") {
    return GROUPS.map((group) => ({ key: group, label: group, ids: ids.filter((id) => store.meta[id]?.group === group) })).filter(
      (section) => section.ids.length > 0,
    )
  }
  return STATUS_SECTIONS.map((section) => ({
    key: section.key,
    label: section.label,
    ids: ids.filter((id) => section.categories.includes(store.category(id))),
  })).filter((section) => section.ids.length > 0)
}

function DDrawer({
  current,
  onCustomize,
  onSettings,
  onActions,
}: {
  current: string | undefined
  onCustomize: () => void
  onSettings: () => void
  onActions: (id: string) => void
}) {
  const store = useProto()
  const nav = useNav()
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState("")
  const ids = store.arranged(searching ? query : "")
  const pinned = store.arrangement.archived ? [] : ids.filter((id) => store.pinned.has(id))
  const rest = ids.filter((id) => !pinned.includes(id))
  const sections = useSections(rest, searching && query.trim().length > 0)
  const { grouping, archived } = store.arrangement
  const headLabel = archived ? "已归档" : grouping === "project" ? "项目" : (sections[0]?.label ?? "会话")

  return (
    <aside className="d-drawer" aria-label="会话菜单">
      <div className="d-drawer-head">
        <span className="d-brand">Pigcode</span>
        <IconButton label="搜索会话" onClick={() => setSearching((value) => !value)}>
          <Search className="ic" aria-hidden="true" />
        </IconButton>
      </div>
      {searching ? (
        <label className="b-search d-search">
          <Search className="ic" aria-hidden="true" />
          <input autoFocus value={query} placeholder="搜索会话" onChange={(event) => setQuery(event.target.value)} />
        </label>
      ) : null}
      <button type="button" className="d-new" onClick={() => nav.go({ screen: "new" })}>
        <SquarePen className="ic" aria-hidden="true" />
        新会话
      </button>
      <div className="m-scroll d-list">
        {store.conn === "offline" ? <div className="m-offline-note">离线 · 上次的结果，标记已隐藏</div> : null}
        {pinned.length > 0 ? (
          <section>
            <h3 className="d-label">置顶</h3>
            {pinned.map((id) => (
              <DRow key={id} id={id} current={current} sub onActions={onActions} />
            ))}
          </section>
        ) : null}
        <div className="d-label">
          <span>{headLabel}</span>
          <button
            type="button"
            className="d-customize"
            data-active={store.filtersActive() || undefined}
            aria-label="分组和筛选"
            title="分组和筛选"
            onClick={onCustomize}
          >
            <SlidersHorizontal className="ic" aria-hidden="true" />
          </button>
        </div>
        {sections.length === 0 ? <div className="d-none">{archived ? "没有已归档的会话" : "没有符合筛选的会话"}</div> : null}
        {sections.map((section, index) =>
          section.projectId && !archived ? (
            <DProject key={section.key} section={section} current={current} onActions={onActions} />
          ) : (
            <section key={section.key}>
              {index > 0 ? <h3 className="d-label">{section.label}</h3> : null}
              {section.ids.map((id) => (
                <DRow key={id} id={id} current={current} sub onActions={onActions} />
              ))}
            </section>
          ),
        )}
      </div>
      <div className="d-foot">
        <button type="button" className="d-computer" onClick={() => nav.go({ screen: "computer", thread: current })}>
          <Laptop className="ic" aria-hidden="true" />
          <ConnLabel conn={store.conn} name />
        </button>
        <button type="button" className="d-settings" aria-label="设置" onClick={onSettings}>
          <Settings className="ic" aria-hidden="true" />
        </button>
      </div>
    </aside>
  )
}

/** 项目块：点项目行折叠或展开；「+」一直显示，在这个项目里开新会话（手机没有悬停）。 */
function DProject({ section, current, onActions }: { section: Section; current: string | undefined; onActions: (id: string) => void }) {
  const store = useProto()
  const nav = useNav()
  const projectId = section.projectId!
  const open = store.expanded[projectId] ?? true
  return (
    <div className="d-proj-block">
      <div className="d-proj">
        <button type="button" className="d-proj-main" aria-expanded={open} onClick={() => store.toggleProject(projectId)}>
          {open ? <FolderOpen className="ic" aria-hidden="true" /> : <Folder className="ic" aria-hidden="true" />}
          <span className="d-proj-name">{section.label}</span>
          <ChevronRight className="ic d-chev" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="d-proj-new"
          aria-label={`在 ${section.label} 里新建会话`}
          onClick={() => nav.go({ screen: "new", project: projectId })}
        >
          <Plus className="ic" aria-hidden="true" />
        </button>
      </div>
      {open ? (
        section.ids.length === 0 ? (
          <div className="d-none d-none-nested">还没有会话</div>
        ) : (
          section.ids.map((id) => <DRow key={id} id={id} current={current} nested onActions={onActions} />)
        )
      ) : null}
    </div>
  )
}

/** 会话行：点一下打开；长按（电脑浏览器里右键）弹出置顶、标为已读、归档。 */
function DRow({
  id,
  current,
  nested,
  sub,
  onActions,
}: {
  id: string
  current: string | undefined
  nested?: boolean
  sub?: boolean
  onActions: (id: string) => void
}) {
  const store = useProto()
  const nav = useNav()
  const timer = useRef<number | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)
  const meta = store.meta[id]
  if (!meta) return null

  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }

  return (
    <button
      type="button"
      className="d-row"
      data-nested={nested || undefined}
      data-current={id === current || undefined}
      data-archived={store.archived.has(id) || undefined}
      onPointerDown={(event) => {
        fired.current = false
        start.current = { x: event.clientX, y: event.clientY }
        cancel()
        timer.current = window.setTimeout(() => {
          fired.current = true
          onActions(id)
        }, 480)
      }}
      onPointerMove={(event) => {
        const origin = start.current
        if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 8) cancel()
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(event) => {
        event.preventDefault()
        cancel()
        fired.current = true
        onActions(id)
      }}
      onClick={() => {
        if (fired.current) {
          fired.current = false
          return
        }
        nav.replace({ screen: "thread", thread: id })
      }}
    >
      <span className="d-row-main">
        <span className="d-row-title">{meta.title}</span>
        {sub ? <span className="d-row-sub">{project(meta.projectId).name}</span> : null}
      </span>
      <RowBadge state={store.stateOf(id)} conn={store.conn} />
    </button>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<[T, string]>
  onChange: (value: T) => void
}) {
  return (
    <div className="b-seg d-seg" role="radiogroup">
      {options.map(([key, label]) => (
        <button key={key} type="button" role="radio" aria-checked={key === value} data-active={key === value || undefined} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  )
}

/** 桌面「自定义侧栏」菜单的手机版：分组、排序、状态筛选、只看已归档、全部标为已读。 */
function DCustomize() {
  const store = useProto()
  const arrangement = store.arrangement
  const unread = store.active().some((id) => store.stateOf(id) === "unread")
  return (
    <div className="d-customize-body">
      <div className="d-field">
        <h4>分组</h4>
        <Segmented<Arrangement["grouping"]>
          value={arrangement.grouping}
          options={[
            ["project", "项目"],
            ["time", "更新时间"],
            ["status", "状态"],
          ]}
          onChange={(grouping) => store.setArrangement({ grouping })}
        />
      </div>
      <div className="d-field">
        <h4>排序</h4>
        <Segmented<Arrangement["sort"]>
          value={arrangement.sort}
          options={[
            ["updated", "更新时间"],
            ["status", "状态"],
          ]}
          onChange={(sort) => store.setArrangement({ sort })}
        />
      </div>
      <div className="d-field">
        <h4>筛选</h4>
        <div className="d-chips">
          {CATEGORIES.map((item) => (
            <button
              key={item.key}
              type="button"
              className="m-pill"
              disabled={arrangement.archived}
              data-active={arrangement.filters.includes(item.key) || undefined}
              onClick={() => store.toggleFilter(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <dl className="m-rows">
          <div>
            <dt>只看已归档</dt>
            <dd>
              <Switch checked={arrangement.archived} onCheckedChange={(archived: boolean) => store.setArrangement({ archived })} />
            </dd>
          </div>
        </dl>
      </div>
      <button type="button" className="m-btn" disabled={!unread} onClick={() => store.markAllRead()}>
        全部标为已读
      </button>
    </div>
  )
}

function DActions({ id, onDone }: { id: string; onDone: () => void }) {
  const store = useProto()
  const state = store.stateOf(id)
  const pinned = store.pinned.has(id)
  const archived = store.archived.has(id)
  const act = (run: () => void) => () => {
    run()
    onDone()
  }
  return (
    <ul className="m-pick d-actions">
      {archived ? null : (
        <li>
          <button type="button" onClick={act(() => store.togglePin(id))}>
            {pinned ? <PinOff className="ic" aria-hidden="true" /> : <Pin className="ic" aria-hidden="true" />}
            <span className="m-pick-text">{pinned ? "取消置顶" : "置顶"}</span>
          </button>
        </li>
      )}
      {state === "unread" ? (
        <li>
          <button type="button" onClick={act(() => store.markRead(id))}>
            <MailOpen className="ic" aria-hidden="true" />
            <span className="m-pick-text">标为已读</span>
          </button>
        </li>
      ) : state === "done" ? (
        <li>
          <button type="button" onClick={act(() => store.markUnread(id))}>
            <Mail className="ic" aria-hidden="true" />
            <span className="m-pick-text">标为未读</span>
          </button>
        </li>
      ) : null}
      <li>
        <button type="button" onClick={act(() => store.toggleArchive(id))}>
          {archived ? <ArchiveRestore className="ic" aria-hidden="true" /> : <Archive className="ic" aria-hidden="true" />}
          <span className="m-pick-text">{archived ? "取消归档" : "归档"}</span>
        </button>
      </li>
    </ul>
  )
}

function DSettings({ onComputer }: { onComputer: () => void }) {
  const [alerts, setAlerts] = useState({ done: true, failed: true, approval: true, question: true })
  const rows: Array<[keyof typeof alerts, string]> = [
    ["done", "一轮跑完"],
    ["failed", "出错或被停下"],
    ["approval", "等你确认"],
    ["question", "向你提问"],
  ]
  return (
    <div className="d-settings-body">
      <dl className="m-rows m-rows-tap">
        <div role="button" tabIndex={0} onClick={onComputer}>
          <dt>电脑</dt>
          <dd>
            {COMPUTER.name}
            <ChevronRight className="ic" aria-hidden="true" />
          </dd>
        </div>
      </dl>
      <h4>通知</h4>
      <dl className="m-rows">
        {rows.map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>
              <Switch checked={alerts[key]} onCheckedChange={(checked: boolean) => setAlerts((value) => ({ ...value, [key]: checked }))} />
            </dd>
          </div>
        ))}
      </dl>
      <p className="m-note">正在看的会话不提醒；另一端已经处理的请求不再提醒。</p>
    </div>
  )
}
