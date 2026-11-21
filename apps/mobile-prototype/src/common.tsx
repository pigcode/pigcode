/**
 * 三套方案共用的部件。按 DSH Go 调研（pigcode/monorepo#105）定下的共同做法：会话行最多一个标记、
 * 连接状态是点加文字、跑完的过程收成一行、每轮末尾一张改动卡、点进去是左右滑切文件的全屏 diff、
 * 运行中发出的消息排在底部。各方案只在摆放和结构上不同。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type TouchEvent } from "react"
import {
  ArrowUp,
  Check,
  ChevronLeft,
  Circle,
  CircleCheck,
  Hand,
  Laptop,
  MessageCircleQuestionMark,
  QrCode,
  ScanLine,
  ShieldCheck,
  Square,
  X,
} from "lucide-react"
import {
  BUILTIN_TOOL_ROWS,
  MessageList,
  ToolRenderersContext,
  toolFamily,
  type ApprovalDecision,
  type ToolRendererEntry,
} from "@pigcode/ui-chat"
import { FileIcon, Spinner, StatusDot, type StatusTone } from "@pigcode/ui-primitives"
import { AGENTS, COMPUTER, PERMISSIONS, PROJECTS, project, type PlanItem } from "./data"
import { useNav, type Conn } from "./nav"
import { useProto, type PendingApproval, type PendingQuestion, type ThreadState } from "./store"

// ─── 连接状态 ────────────────────────────────────────────

export interface ConnInfo {
  tone: StatusTone
  text: string
  detail: string
}

export function connInfo(conn: Conn): ConnInfo {
  if (conn === "reconnecting") return { tone: "checking", text: "重新连接中", detail: "第 2 次 · 网络切换后自动重试" }
  if (conn === "offline")
    return { tone: "idle", text: "电脑离线", detail: `最后在线 ${COMPUTER.lastSeen} · 可能睡眠或合上了盖子` }
  return { tone: "ready", text: "已连接", detail: `${COMPUTER.route} · ${COMPUTER.latency}` }
}

/** 点加文字；颜色从不单独表达状态。 */
export function ConnLabel({ conn, name = false }: { conn: Conn; name?: boolean }) {
  const info = connInfo(conn)
  return (
    <span className="m-conn" data-conn={conn}>
      <StatusDot tone={info.tone} />
      {name ? <span className="m-conn-name">{COMPUTER.name}</span> : null}
      <span className="m-conn-text">{info.text}</span>
    </span>
  )
}

/** 发不出去时的原因；在线时为 undefined。 */
export function blockedReason(conn: Conn): string | undefined {
  if (conn === "reconnecting") return "正在重新连接，连上后再发送"
  if (conn === "offline") return "电脑离线，消息发不出去"
  return undefined
}

// ─── 会话行的标记 ────────────────────────────────────────

const STATE_TEXT: Record<ThreadState, string> = {
  approval: "等你确认",
  question: "等你回答",
  running: "运行中",
  failed: "出错",
  unread: "未读",
  done: "已完成",
}

export function stateText(state: ThreadState): string {
  return STATE_TEXT[state]
}

/** 每行最多一个标记：等你处理 > 运行中 > 未读；出错一直是红色。断线时隐藏，因为已经不可信。 */
export function RowBadge({ state, conn }: { state: ThreadState; conn: Conn }) {
  if (conn === "offline") return null
  if (state === "approval" || state === "question")
    return <span className="m-badge m-badge-warn">{STATE_TEXT[state]}</span>
  if (state === "failed") return <span className="m-badge m-badge-bad">出错</span>
  if (state === "running") return <StatusDot tone="running" label="运行中" className="m-badge-dot" />
  if (state === "unread") return <StatusDot tone="ready" label="未读" className="m-badge-dot" />
  return null
}

// ─── 打开的会话 ──────────────────────────────────────────

/** 进入会话时登记为正在看：跑完直接算看过，「运行中」的脚本从这时开始。 */
export function useOpenThread(id: string | undefined): void {
  const store = useProto()
  useEffect(() => {
    store.setOpen(id)
    return () => store.setOpen(undefined)
  }, [store, id])
}

export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  return (
    <span className="m-tabular">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
    </span>
  )
}

// ─── 时间线 ──────────────────────────────────────────────

/** 和桌面端窗口登记的一样：按工具族选内置工具行（窗口里经扩展点交给时间线）。 */
const TOOL_RENDERERS: readonly ToolRendererEntry[] = BUILTIN_TOOL_ROWS.map(([family, render]) => ({
  matches: (name: string) => toolFamily(name) === family,
  render,
}))

/**
 * 桌面端的 MessageList 原样放进手机的滚动区：工具行、摘要组、审批卡、提问卡和改动汇总卡都是真实组件。
 * 贴底时跟着新内容走，上翻后不打扰。
 */
export function Timeline({
  id,
  onViewDiff,
  className,
}: {
  id: string
  onViewDiff: (path?: string) => void
  className?: string | undefined
}) {
  const store = useProto()
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const events = store.events[id] ?? []
  const live = store.live[id]
  const queued = store.queued[id] ?? []
  const meta = store.meta[id]
  const blocked = store.conn !== "online"

  useLayoutEffect(() => {
    const node = scroller.current
    if (node && stick.current) node.scrollTop = node.scrollHeight
  })

  return (
    <div className={`view chat-view m-chat ${className ?? ""}`} data-blocked={blocked || undefined}>
      <div className="thread-wrap">
        <div
          className="thread"
          ref={scroller}
          onScroll={(event) => {
            const node = event.currentTarget
            stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
          }}
        >
          <ToolRenderersContext.Provider value={TOOL_RENDERERS}>
            <MessageList
              events={events}
              streamingText={live?.text ?? ""}
              liveOutput={live?.output}
              root={project(meta?.projectId ?? "pigcode").root}
              onApproval={(requestId: string, decision: ApprovalDecision) => store.resolveApproval(id, requestId, decision)}
              onAnswer={(requestId: string, answers: string[]) => store.answerQuestion(id, requestId, answers)}
              onViewDiff={onViewDiff}
            />
          </ToolRenderersContext.Provider>
          {queued.length > 0 ? (
            <div className="m-queue">
              {queued.map((item) => (
                <div key={item.id} className="m-queued">
                  <div className="m-queued-text">{item.text}</div>
                  <div className="m-queued-meta">
                    <span>排队中 · 这一轮结束后发送</span>
                    <button type="button" onClick={() => store.sendNow(id, item.id)}>
                      立即发送
                    </button>
                    <button type="button" onClick={() => store.withdraw(id, item.id)}>
                      撤回
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** 滚到时间线里的审批卡或提问卡。 */
export function scrollToPending(): void {
  const card = document.querySelector(".m-chat .perm, .m-chat .question-card, .m-chat [role='group']")
  card?.scrollIntoView({ behavior: "smooth", block: "center" })
}

// ─── 输入框 ──────────────────────────────────────────────

export function Composer({
  id,
  placeholder,
  header,
  footer,
  onSend,
}: {
  id: string
  placeholder?: string | undefined
  header?: ReactNode
  footer?: ReactNode
  /** 新会话用：发送时建会话，而不是往已有会话里发。 */
  onSend?: ((text: string) => void) | undefined
}) {
  const store = useProto()
  const value = store.drafts[id] ?? ""
  const running = Boolean(store.runId(id))
  const blocked = blockedReason(store.conn)
  const area = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const node = area.current
    if (!node) return
    node.style.height = "0px"
    node.style.height = `${Math.min(node.scrollHeight, 140)}px`
  }, [value])

  const shown = blocked ?? placeholder ?? (running ? "运行中 · 发出的消息会排队" : "回复…")
  const canSend = !blocked && value.trim().length > 0

  return (
    <div className="m-composer" data-disabled={blocked ? true : undefined}>
      {header}
      <div className="m-composer-row">
        <textarea
          ref={area}
          rows={1}
          value={value}
          disabled={Boolean(blocked)}
          placeholder={shown}
          onChange={(event) => store.setDraft(id, event.target.value)}
        />
        {running && !canSend ? (
          <button type="button" className="m-send m-stop" aria-label="停下" disabled={Boolean(blocked)} onClick={() => store.stop(id)}>
            <Square className="ic" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className="m-send"
            aria-label="发送"
            disabled={!canSend}
            onClick={() => (onSend ? onSend(value.trim()) : store.send(id, value))}
          >
            <ArrowUp className="ic" aria-hidden="true" />
          </button>
        )}
      </div>
      {footer}
    </div>
  )
}

// ─── 导航栏和弹层 ────────────────────────────────────────

export function NavBar({
  left,
  title,
  subtitle,
  right,
  large,
}: {
  left?: ReactNode
  title?: ReactNode
  subtitle?: ReactNode
  right?: ReactNode
  large?: boolean
}) {
  return (
    <header className="m-nav" data-large={large || undefined}>
      <div className="m-nav-side">{left}</div>
      <div className="m-nav-title">
        {title ? <div className="m-nav-main">{title}</div> : null}
        {subtitle ? <div className="m-nav-sub">{subtitle}</div> : null}
      </div>
      <div className="m-nav-side m-nav-right">{right}</div>
    </header>
  )
}

export function IconButton({
  label,
  onClick,
  children,
  badge,
}: {
  label: string
  onClick?: () => void
  children: ReactNode
  badge?: ReactNode
}) {
  return (
    <button type="button" className="m-icon-btn" aria-label={label} title={label} onClick={onClick}>
      {children}
      {badge}
    </button>
  )
}

export function BackButton({ label, onClick }: { label?: string; onClick: () => void }) {
  return (
    <button type="button" className="m-back" onClick={onClick}>
      <ChevronLeft className="ic" aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </button>
  )
}

export function Sheet({
  open,
  title,
  onClose,
  children,
  tall,
}: {
  open: boolean
  title?: ReactNode
  onClose: () => void
  children: ReactNode
  tall?: boolean
}) {
  if (!open) return null
  return (
    <div className="m-sheet-layer">
      <button type="button" className="m-scrim" aria-label="关闭" onClick={onClose} />
      <section className="m-sheet" data-tall={tall || undefined} role="dialog" aria-modal="true">
        <div className="m-grabber" />
        {title ? (
          <div className="m-sheet-head">
            <div className="m-sheet-title">{title}</div>
            <button type="button" className="m-icon-btn" aria-label="关闭" onClick={onClose}>
              <X className="ic" aria-hidden="true" />
            </button>
          </div>
        ) : null}
        <div className="m-sheet-body">{children}</div>
      </section>
    </div>
  )
}

/** 从一组选项里选一个的弹层内容。 */
export function PickList({
  items,
  value,
  onPick,
}: {
  items: Array<{ value: string; label: string; hint?: string | undefined }>
  value: string
  onPick: (value: string) => void
}) {
  return (
    <ul className="m-pick">
      {items.map((item) => (
        <li key={item.value}>
          <button type="button" onClick={() => onPick(item.value)}>
            <span className="m-pick-text">
              <span>{item.label}</span>
              {item.hint ? <span className="m-pick-hint">{item.hint}</span> : null}
            </span>
            {item.value === value ? <Check className="ic" aria-hidden="true" /> : null}
          </button>
        </li>
      ))}
    </ul>
  )
}

// ─── 新会话的选项 ────────────────────────────────────────

export type Picker = "project" | "agent" | "model" | "permission"

const PICKER_TITLE: Record<Picker, string> = {
  project: "项目",
  agent: "Agent 实例",
  model: "模型",
  permission: "权限模式",
}

const PERMISSION_HINT: Record<string, string> = {
  监督审批: "改文件、跑命令前都先问你",
  接受编辑: "改文件不问，跑命令先问",
  自动审批: "Agent 自己判断，有风险的才问",
  完全访问: "什么都不问",
}

/** 新会话的选项和发送；三套方案只是摆法不同。 */
export function useNewThreadForm() {
  const store = useProto()
  const nav = useNav()
  const [projectId, setProjectId] = useState("pigcode")
  const [agentId, setAgentId] = useState("claude")
  const agent = AGENTS.find((item) => item.id === agentId) ?? AGENTS[0]!
  const [model, setModel] = useState(agent.models[0]!)
  const [permission, setPermission] = useState("完全访问")
  const [picker, setPicker] = useState<Picker | null>(null)

  const items: Record<Picker, Array<{ value: string; label: string; hint?: string | undefined }>> = {
    project: PROJECTS.map((item) => ({ value: item.id, label: item.name, hint: item.root.replace("/Users/liuqin", "~") })),
    agent: AGENTS.map((item) => ({ value: item.id, label: item.name, hint: item.models.join(" · ") })),
    model: agent.models.map((item) => ({ value: item, label: item })),
    permission: PERMISSIONS.map((item) => ({ value: item, label: item, hint: PERMISSION_HINT[item] })),
  }
  const values: Record<Picker, string> = { project: projectId, agent: agentId, model, permission }

  function pick(kind: Picker, value: string) {
    if (kind === "project") setProjectId(value)
    if (kind === "agent") {
      setAgentId(value)
      setModel(AGENTS.find((item) => item.id === value)?.models[0] ?? model)
    }
    if (kind === "model") setModel(value)
    if (kind === "permission") setPermission(value)
    setPicker(null)
  }

  function submit(text: string) {
    const id = store.createThread({ projectId, agent: agent.name, model, permission, text })
    store.setDraft("new", "")
    nav.replace({ screen: "thread", thread: id })
  }

  return { project: project(projectId), agent, model, permission, picker, setPicker, items, values, pick, submit }
}

export type NewThreadForm = ReturnType<typeof useNewThreadForm>

export function PickerSheet({ form }: { form: NewThreadForm }) {
  const kind = form.picker
  return (
    <Sheet open={Boolean(kind)} title={kind ? PICKER_TITLE[kind] : ""} onClose={() => form.setPicker(null)}>
      {kind ? <PickList items={form.items[kind]} value={form.values[kind]} onPick={(value) => form.pick(kind, value)} /> : null}
    </Sheet>
  )
}

// ─── 审批和提问 ──────────────────────────────────────────

/** 审批的内容：拒绝和允许本次等宽并排，主色只给允许；更宽的授权降成文字按钮。 */
export function ApprovalBody({
  approval,
  onDecide,
  compact,
}: {
  approval: PendingApproval
  onDecide: (decision: ApprovalDecision) => void
  compact?: boolean
}) {
  const store = useProto()
  const blocked = blockedReason(store.conn)
  return (
    <div className="m-approval" data-compact={compact || undefined}>
      <div className="m-approval-q">
        <Hand className="ic" aria-hidden="true" />
        <span>{approval.title}</span>
      </div>
      {approval.description && !compact ? <p className="m-approval-desc">{approval.description}</p> : null}
      {approval.command ? <pre className="m-approval-cmd">{approval.command}</pre> : null}
      {blocked ? <p className="m-blocked">{blocked}</p> : null}
      <div className="m-approval-acts">
        <button type="button" className="m-btn" disabled={Boolean(blocked)} onClick={() => onDecide("deny")}>
          拒绝
        </button>
        <button type="button" className="m-btn m-btn-primary" disabled={Boolean(blocked)} onClick={() => onDecide("allow-once")}>
          允许本次
        </button>
      </div>
      {compact ? null : (
        <button type="button" className="m-text-btn" disabled={Boolean(blocked)} onClick={() => onDecide("allow-for-session")}>
          这个会话里都允许
        </button>
      )}
    </div>
  )
}

/** 提问的内容：单选题点一下就是回答，也可以自己写。 */
export function QuestionBody({
  question,
  onAnswer,
  compact,
}: {
  question: PendingQuestion
  onAnswer: (answers: string[]) => void
  compact?: boolean
}) {
  const store = useProto()
  const blocked = blockedReason(store.conn)
  const [other, setOther] = useState("")
  const first = question.questions[0]
  if (!first) return null
  return (
    <div className="m-question" data-compact={compact || undefined}>
      <div className="m-approval-q">
        <MessageCircleQuestionMark className="ic" aria-hidden="true" />
        <span>{first.question}</span>
      </div>
      {blocked ? <p className="m-blocked">{blocked}</p> : null}
      <div className="m-options">
        {first.options.map((option) => (
          <button
            key={option.label}
            type="button"
            className="m-option"
            disabled={Boolean(blocked)}
            onClick={() => onAnswer([option.label])}
          >
            <span className="m-option-label">{option.label}</span>
            {option.description && !compact ? <span className="m-option-hint">{option.description}</span> : null}
          </button>
        ))}
      </div>
      {compact ? null : (
        <div className="m-other">
          <input
            value={other}
            disabled={Boolean(blocked)}
            placeholder="其他回答…"
            onChange={(event) => setOther(event.target.value)}
          />
          <button
            type="button"
            className="m-btn m-btn-primary"
            disabled={Boolean(blocked) || !other.trim()}
            onClick={() => onAnswer([other.trim()])}
          >
            回答
          </button>
        </div>
      )}
    </div>
  )
}

// ─── 计划 ────────────────────────────────────────────────

export function planProgress(items: readonly PlanItem[]): { done: number; total: number; current?: string | undefined } {
  return {
    done: items.filter((item) => item.status === "done").length,
    total: items.length,
    current: items.find((item) => item.status === "doing")?.text,
  }
}

export function PlanList({ items }: { items: readonly PlanItem[] }) {
  return (
    <ol className="m-plan">
      {items.map((item) => (
        <li key={item.text} data-status={item.status}>
          {item.status === "done" ? (
            <CircleCheck className="ic" aria-hidden="true" />
          ) : item.status === "doing" ? (
            <Spinner className="ic" aria-hidden="true" />
          ) : (
            <Circle className="ic" aria-hidden="true" />
          )}
          <span>{item.text}</span>
        </li>
      ))}
    </ol>
  )
}

// ─── 全屏 diff ───────────────────────────────────────────

/** 顶上一排文件胶囊，左右滑切换文件；默认换行，否则横向滚动会吃掉切文件的手势。 */
export function DiffScreen({ id, file, onBack }: { id: string; file?: string | undefined; onBack: () => void }) {
  const store = useProto()
  const files = store.files(id)
  const [index, setIndex] = useState(() => Math.max(0, files.findIndex((item) => item.path === file)))
  const [wrap, setWrap] = useState(true)
  const touch = useRef<{ x: number; y: number } | null>(null)
  const current = files[index]

  function onTouchStart(event: TouchEvent) {
    const point = event.touches[0]
    if (point) touch.current = { x: point.clientX, y: point.clientY }
  }
  function onTouchEnd(event: TouchEvent) {
    const start = touch.current
    const point = event.changedTouches[0]
    touch.current = null
    if (!start || !point) return
    const dx = point.clientX - start.x
    const dy = point.clientY - start.y
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return
    setIndex((at) => Math.min(files.length - 1, Math.max(0, at + (dx < 0 ? 1 : -1))))
  }

  return (
    <div className="m-screen m-diff">
      <NavBar
        left={<BackButton onClick={onBack} />}
        title="改动"
        subtitle={`${files.length} 个文件`}
        right={
          <button type="button" className="m-text-btn" onClick={() => setWrap((value) => !value)}>
            {wrap ? "不换行" : "换行"}
          </button>
        }
      />
      <div className="m-diff-pills">
        {files.map((item, at) => (
          <button key={item.path} type="button" data-active={at === index || undefined} onClick={() => setIndex(at)}>
            <FileIcon name={item.name} kind="file" />
            <span>{item.name}</span>
            <span className="m-add">+{item.added}</span>
            <span className="m-del">−{item.removed}</span>
          </button>
        ))}
      </div>
      {current ? (
        <div className="m-diff-body" data-wrap={wrap || undefined} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          <div className="m-diff-path">{current.dir ? `${current.dir}/` : ""}{current.name}</div>
          <div className="m-diff-lines">
            {current.rows.map((row, at) =>
              row.kind === "gap" ? (
                <div key={at} className="m-diff-gap">⋯</div>
              ) : (
                <div key={at} className="m-diff-row" data-kind={row.kind}>
                  <span className="m-diff-no">{row.newNo ?? row.oldNo ?? ""}</span>
                  <span className="m-diff-sign">{row.kind === "add" ? "+" : row.kind === "remove" ? "−" : ""}</span>
                  <span className="m-diff-text">{row.text || " "}</span>
                </div>
              ),
            )}
          </div>
          {files.length > 1 ? <div className="m-diff-hint">左右滑动切换文件 · {index + 1}/{files.length}</div> : null}
        </div>
      ) : (
        <div className="m-empty">这一轮没有改动文件</div>
      )}
    </div>
  )
}

/** 会话里改过的文件列表。 */
export function FileList({ id, onOpen }: { id: string; onOpen: (path: string) => void }) {
  const store = useProto()
  const files = store.files(id)
  if (files.length === 0) return <div className="m-empty">这个会话还没有改动文件</div>
  return (
    <ul className="m-files">
      {files.map((file) => (
        <li key={file.path}>
          <button type="button" onClick={() => onOpen(file.path)}>
            <FileIcon name={file.name} kind="file" />
            <span className="m-file-name">{file.name}</span>
            <span className="m-file-dir">{file.dir}</span>
            <span className="m-add">+{file.added}</span>
            <span className="m-del">−{file.removed}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

// ─── 电脑和配对 ──────────────────────────────────────────

export function ComputerDetails({ onPair }: { onPair: () => void }) {
  const store = useProto()
  const info = connInfo(store.conn)
  return (
    <div className="m-computer">
      <div className="m-computer-hero">
        <Laptop className="ic" aria-hidden="true" />
        <div>
          <div className="m-computer-name">{COMPUTER.name}</div>
          <ConnLabel conn={store.conn} />
        </div>
      </div>
      <dl className="m-rows">
        <div>
          <dt>状态</dt>
          <dd>{info.detail}</dd>
        </div>
        <div>
          <dt>连接方式</dt>
          <dd>{COMPUTER.route}</dd>
        </div>
        <div>
          <dt>最后在线</dt>
          <dd>{store.conn === "online" ? "现在" : COMPUTER.lastSeen}</dd>
        </div>
        <div>
          <dt>电脑指纹</dt>
          <dd className="m-mono">{COMPUTER.fingerprint.slice(0, 19)}…</dd>
        </div>
      </dl>
      <div className="m-stack">
        {store.conn === "online" ? null : (
          <button type="button" className="m-btn m-btn-primary" onClick={() => store.setConn("online")}>
            立即重试
          </button>
        )}
        <button type="button" className="m-btn" onClick={onPair}>
          配对另一台电脑
        </button>
      </div>
      <p className="m-note">电脑睡眠、合盖或 Pigcode 退出时连不上，手机上显示最后在线时间；电脑醒来后自动重连。</p>
    </div>
  )
}

type PairStep = "intro" | "scan" | "confirm" | "approve" | "done"

/** 配对：扫电脑上的二维码，核对电脑指纹，在电脑上点允许。协议细节由「配对、设备身份与加密」决定。 */
export function PairingFlow({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [step, setStep] = useState<PairStep>("intro")

  useEffect(() => {
    if (step === "scan") {
      const timer = window.setTimeout(() => setStep("confirm"), 2200)
      return () => window.clearTimeout(timer)
    }
    if (step === "approve") {
      const timer = window.setTimeout(() => setStep("done"), 2600)
      return () => window.clearTimeout(timer)
    }
    return undefined
  }, [step])

  if (step === "intro")
    return (
      <div className="m-pair">
        <QrCode className="m-pair-art" aria-hidden="true" />
        <h2>连接你的电脑</h2>
        <ol className="m-pair-steps">
          <li>在电脑上打开 Pigcode</li>
          <li>进入「设置 → 手机」，点「添加手机」</li>
          <li>用这台手机扫电脑上的二维码</li>
        </ol>
        <div className="m-stack">
          <button type="button" className="m-btn m-btn-primary" onClick={() => setStep("scan")}>
            扫描二维码
          </button>
          <button type="button" className="m-text-btn" onClick={onCancel}>
            以后再说
          </button>
        </div>
      </div>
    )

  if (step === "scan")
    return (
      <div className="m-pair m-pair-camera" onClick={() => setStep("confirm")}>
        <div className="m-viewfinder">
          <ScanLine className="m-scanline" aria-hidden="true" />
        </div>
        <p>对准电脑上的二维码</p>
        <button type="button" className="m-text-btn m-on-dark" onClick={onCancel}>
          取消
        </button>
      </div>
    )

  if (step === "confirm")
    return (
      <div className="m-pair">
        <Laptop className="m-pair-art" aria-hidden="true" />
        <h2>要连接这台电脑吗？</h2>
        <dl className="m-rows">
          <div>
            <dt>电脑</dt>
            <dd>{COMPUTER.name}</dd>
          </div>
          <div>
            <dt>中继</dt>
            <dd>{COMPUTER.relay}</dd>
          </div>
        </dl>
        <div className="m-fingerprint">
          <div className="m-fingerprint-label">电脑指纹</div>
          <div className="m-mono">{COMPUTER.fingerprint}</div>
        </div>
        <p className="m-note">和电脑上显示的指纹一致再继续。</p>
        <div className="m-row-btns">
          <button type="button" className="m-btn" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="m-btn m-btn-primary" onClick={() => setStep("approve")}>
            连接
          </button>
        </div>
      </div>
    )

  if (step === "approve")
    return (
      <div className="m-pair">
        <Spinner className="m-pair-art" aria-hidden="true" />
        <h2>在电脑上点「允许」</h2>
        <p className="m-note">电脑上会出现「允许 iPhone 连接这台电脑？」，确认后这台手机就配对好了。撤销也在电脑上做。</p>
        <button type="button" className="m-text-btn" onClick={onCancel}>
          取消
        </button>
      </div>
    )

  return (
    <div className="m-pair">
      <ShieldCheck className="m-pair-art m-ok" aria-hidden="true" />
      <h2>已连接 {COMPUTER.name}</h2>
      <p className="m-note">内容在手机和电脑之间端到端加密，中继看不到。</p>
      <button type="button" className="m-btn m-btn-primary" onClick={onDone}>
        开始使用
      </button>
    </div>
  )
}
