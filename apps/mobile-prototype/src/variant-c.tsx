/**
 * 方案 C「对话优先」，结构最接近 DSH Go：打开就是最近的会话，会话列表收在左侧抽屉里，
 * 电脑状态放在抽屉底部和标题下面；输入框上方的活动条写着 Agent 此刻在做什么；
 * 审批和提问直接占住输入框的位置，按钮在拇指下面。
 */
import { useState, type ReactNode } from "react"
import { ChevronDown, ChevronUp, Folder, Menu, SquarePen } from "lucide-react"
import { StatusDot } from "@pigcode/ui-primitives"
import {
  ApprovalBody,
  Composer,
  ComputerDetails,
  ConnLabel,
  DiffScreen,
  Elapsed,
  IconButton,
  PairingFlow,
  PickerSheet,
  PlanList,
  planProgress,
  QuestionBody,
  RowBadge,
  Sheet,
  Timeline,
  useNewThreadForm,
  useOpenThread,
} from "./common"
import { project, type Group } from "./data"
import { useNav } from "./nav"
import { useProto } from "./store"

type Filter = "all" | "attention" | "running"

const GROUPS: Group[] = ["今天", "昨天", "更早"]
const DEFAULT_THREAD = "t-running"

export function VariantC() {
  const nav = useNav()
  const { place } = nav
  const current = place.thread ?? DEFAULT_THREAD
  if (place.screen === "diff" && place.thread) {
    return <DiffScreen id={place.thread} file={place.file} onBack={() => nav.back({ screen: "thread", thread: place.thread })} />
  }
  if (place.screen === "pair") {
    return (
      <div className="m-screen v-c">
        <PairingFlow onDone={() => nav.replace({ screen: "thread", thread: current })} onCancel={() => nav.back({ screen: "thread", thread: current })} />
      </div>
    )
  }
  const drawerOpen = place.screen === "list" || place.screen === "inbox"
  return (
    <div className="m-screen v-c">
      {place.screen === "new" ? <CNew /> : <CThread id={current} />}
      <CDrawer open={drawerOpen} current={place.screen === "new" ? undefined : current} />
      <Sheet open={place.screen === "computer"} title="电脑" onClose={() => nav.back({ screen: "thread", thread: current })}>
        <ComputerDetails onPair={() => nav.go({ screen: "pair", thread: current })} />
      </Sheet>
    </div>
  )
}

function CHeader({ title, sub, onNew }: { title: string; sub: ReactNode; onNew: () => void }) {
  const store = useProto()
  const nav = useNav()
  const { attention } = store.counts()
  return (
    <header className="m-nav c-head">
      <div className="m-nav-side">
        <IconButton
          label="会话列表"
          onClick={() => nav.go({ screen: "list", thread: nav.place.thread })}
          badge={attention > 0 && store.conn !== "offline" ? <span className="c-menu-dot" /> : null}
        >
          <Menu className="ic" aria-hidden="true" />
        </IconButton>
      </div>
      <div className="c-title">
        <span className="c-title-main">{title}</span>
        <span className="c-title-sub">{sub}</span>
      </div>
      <div className="m-nav-side m-nav-right">
        <IconButton label="新会话" onClick={onNew}>
          <SquarePen className="ic" aria-hidden="true" />
        </IconButton>
      </div>
    </header>
  )
}

function CThread({ id }: { id: string }) {
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
    <div className="c-main">
      <CHeader title={meta.title} sub={sub} onNew={() => nav.go({ screen: "new" })} />
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
    </div>
  )
}

/** 输入框正上方的一颗胶囊：此刻在做什么、本轮用时、计划进度。 */
export function CActivity({ id, onOpen }: { id: string; onOpen: () => void }) {
  const store = useProto()
  const tool = store.activeTool(id)
  const started = store.runStartedAt(id)
  const plan = store.plans[id]
  const progress = plan ? planProgress(plan) : undefined
  const live = store.live[id]?.text
  const doing = tool ? `正在 ${tool.text}` : live ? "正在回答" : "正在思考"
  return (
    <button type="button" className="c-activity" onClick={onOpen}>
      <StatusDot tone="running" />
      <span className="c-activity-text">{doing}</span>
      {started ? (
        <span className="c-activity-time">
          <Elapsed since={started} />
        </span>
      ) : null}
      {progress ? (
        <span className="c-activity-plan m-tabular">
          {progress.done}/{progress.total}
        </span>
      ) : null}
      <ChevronUp className="ic" aria-hidden="true" />
    </button>
  )
}

function CDrawer({ open, current }: { open: boolean; current: string | undefined }) {
  const store = useProto()
  const nav = useNav()
  const [chosen, setChosen] = useState<Filter>("all")
  const filter: Filter = nav.place.screen === "inbox" ? "attention" : chosen
  const counts = store.counts()
  const ids = store.active().filter((id) =>
    filter === "all" ? true : filter === "attention" ? store.needsAttention(id) : store.stateOf(id) === "running",
  )
  const close = () => nav.replace({ screen: current ? "thread" : "new", thread: current })

  return (
    <div className="c-drawer-layer" data-open={open || undefined} aria-hidden={!open}>
      <button type="button" className="m-scrim" aria-label="关闭" tabIndex={open ? 0 : -1} onClick={close} />
      <aside className="c-drawer">
        <div className="c-drawer-head">
          <span className="c-brand">Pigcode</span>
          <button type="button" className="m-chip" onClick={() => nav.go({ screen: "new" })}>
            <SquarePen className="ic" aria-hidden="true" />
            新会话
          </button>
        </div>
        <div className="m-pills">
          <button type="button" className="m-pill" data-active={filter === "all" || undefined} onClick={() => setChosen("all")}>
            全部
          </button>
          <button type="button" className="m-pill" data-active={filter === "attention" || undefined} onClick={() => setChosen("attention")}>
            需要处理 <span className="m-count">{counts.attention}</span>
          </button>
          <button type="button" className="m-pill" data-active={filter === "running" || undefined} onClick={() => setChosen("running")}>
            运行中 <span className="m-count">{counts.running}</span>
          </button>
        </div>
        <div className="m-scroll">
          {store.conn === "offline" ? <div className="m-offline-note">离线 · 上次的结果</div> : null}
          {GROUPS.map((group) => {
            const rows = ids.filter((id) => store.meta[id]?.group === group)
            if (rows.length === 0) return null
            return (
              <section key={group}>
                <h3 className="m-group">{group}</h3>
                {rows.map((id) => {
                  const meta = store.meta[id]!
                  return (
                    <button
                      key={id}
                      type="button"
                      className="c-row"
                      data-current={id === current || undefined}
                      onClick={() => nav.replace({ screen: "thread", thread: id })}
                    >
                      <span className="c-row-main">
                        <span className="c-row-title">{meta.title}</span>
                        <span className="c-row-project">{project(meta.projectId).name}</span>
                      </span>
                      <RowBadge state={store.stateOf(id)} conn={store.conn} />
                    </button>
                  )
                })}
              </section>
            )
          })}
        </div>
        <button type="button" className="c-computer" onClick={() => nav.go({ screen: "computer", thread: current })}>
          <ConnLabel conn={store.conn} name />
          <ChevronUp className="ic" aria-hidden="true" />
        </button>
      </aside>
    </div>
  )
}

function CNew() {
  const form = useNewThreadForm()
  return (
    <div className="c-main">
      <CHeader title="新会话" sub={form.project.name} onNew={() => undefined} />
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
    </div>
  )
}
