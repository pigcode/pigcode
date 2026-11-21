/**
 * 方案 A「收件箱」：首页是一张跨项目的会话列表，「需要处理」用筛选胶囊一键切出来；
 * 电脑状态是列表顶部的一条；进会话整屏推入，审批卡留在时间线里，输入框上方钉一条「等你确认」跳过去。
 */
import { useState } from "react"
import { ChevronDown, ChevronUp, FileDiff, Folder, Hand, Laptop, ListChecks, Plus, X } from "lucide-react"
import {
  BackButton,
  Composer,
  ComputerDetails,
  ConnLabel,
  connInfo,
  DiffScreen,
  IconButton,
  NavBar,
  PairingFlow,
  PickerSheet,
  PlanList,
  planProgress,
  RowBadge,
  scrollToPending,
  Sheet,
  stateText,
  Timeline,
  useNewThreadForm,
  useOpenThread,
} from "./common"
import { COMPUTER, project, type Group, type PlanItem } from "./data"
import { useNav } from "./nav"
import { useProto } from "./store"

type Filter = "all" | "attention" | "running"

const GROUPS: Group[] = ["今天", "昨天", "更早"]

export function VariantA() {
  const { place } = useNav()
  if (place.screen === "pair") return <APair />
  if (place.screen === "new") return <ANew />
  if (place.screen === "thread" && place.thread) return <AThread id={place.thread} />
  if (place.screen === "diff" && place.thread) return <ADiff id={place.thread} file={place.file} />
  return <AList />
}

function AList() {
  const store = useProto()
  const nav = useNav()
  const [chosen, setChosen] = useState<Filter>("all")
  const filter: Filter = nav.place.screen === "inbox" ? "attention" : chosen
  const counts = store.counts()
  const info = connInfo(store.conn)

  const choose = (next: Filter) => {
    setChosen(next)
    if (nav.place.screen === "inbox" && next !== "attention") nav.replace({ screen: "list" })
  }

  const ids = store.order.filter((id) =>
    filter === "all" ? true : filter === "attention" ? store.needsAttention(id) : store.stateOf(id) === "running",
  )

  return (
    <div className="m-screen v-a">
      <NavBar
        large
        title="会话"
        right={
          <IconButton label="电脑" onClick={() => nav.go({ screen: "computer" })}>
            <Laptop className="ic" aria-hidden="true" />
          </IconButton>
        }
      />
      <button type="button" className="a-conn" data-conn={store.conn} onClick={() => nav.go({ screen: "computer" })}>
        <ConnLabel conn={store.conn} name />
        <span className="a-conn-detail">{store.conn === "online" ? COMPUTER.route : info.detail}</span>
        {store.conn === "online" ? null : <span className="a-conn-action">详情</span>}
      </button>
      <div className="m-pills">
        <button type="button" className="m-pill" data-active={filter === "all" || undefined} onClick={() => choose("all")}>
          全部
        </button>
        <button type="button" className="m-pill" data-active={filter === "attention" || undefined} onClick={() => choose("attention")}>
          需要处理 <span className="m-count">{counts.attention}</span>
        </button>
        <button type="button" className="m-pill" data-active={filter === "running" || undefined} onClick={() => choose("running")}>
          运行中 <span className="m-count">{counts.running}</span>
        </button>
      </div>
      {store.conn === "offline" ? (
        <div className="m-offline-note">离线 · 下面是 {COMPUTER.lastSeen} 的结果，标记已隐藏</div>
      ) : null}
      <div className="m-scroll a-list">
        {ids.length === 0 ? <div className="m-empty">没有需要你处理的会话</div> : null}
        {GROUPS.map((group) => {
          const rows = ids.filter((id) => store.meta[id]?.group === group)
          if (rows.length === 0) return null
          return (
            <section key={group}>
              <h3 className="m-group">{group}</h3>
              <ul className="a-rows">
                {rows.map((id) => {
                  const meta = store.meta[id]!
                  return (
                    <li key={id}>
                      <button type="button" className="a-row" onClick={() => nav.go({ screen: "thread", thread: id })}>
                        <span className="a-row-main">
                          <span className="a-row-title">{meta.title}</span>
                          <span className="a-row-sub">
                            {project(meta.projectId).name} · {meta.time}
                          </span>
                        </span>
                        <RowBadge state={store.stateOf(id)} conn={store.conn} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>
      <button type="button" className="m-fab" aria-label="新会话" onClick={() => nav.go({ screen: "new" })}>
        <Plus className="ic" aria-hidden="true" />
      </button>
      <Sheet open={nav.place.screen === "computer"} title="电脑" onClose={() => nav.back({ screen: "list" })}>
        <ComputerDetails onPair={() => nav.go({ screen: "pair" })} />
      </Sheet>
    </div>
  )
}

function AThread({ id }: { id: string }) {
  useOpenThread(id)
  const store = useProto()
  const nav = useNav()
  const meta = store.meta[id]
  if (!meta) return <AList />
  const state = store.stateOf(id)
  const files = store.files(id)
  const plan = store.plans[id]
  const approval = store.pendingApproval(id)
  const question = store.pendingQuestion(id)

  return (
    <div className="m-screen v-a">
      <NavBar
        left={<BackButton label="会话" onClick={() => nav.back({ screen: "list" })} />}
        title={meta.title}
        subtitle={
          store.conn === "online" ? (
            `${project(meta.projectId).name} · ${stateText(state)}`
          ) : (
            <ConnLabel conn={store.conn} />
          )
        }
        right={
          files.length > 0 ? (
            <button type="button" className="a-diff-btn" onClick={() => nav.go({ screen: "diff", thread: id })}>
              <FileDiff className="ic" aria-hidden="true" />
              {files.length}
            </button>
          ) : null
        }
      />
      <Timeline id={id} onViewDiff={(path) => nav.go({ screen: "diff", thread: id, file: path })} />
      <div className="m-dock">
        {approval || question ? (
          <button type="button" className="a-pending" onClick={scrollToPending}>
            <Hand className="ic" aria-hidden="true" />
            <span className="a-pending-text">
              {approval ? `等你确认：${approval.command ?? approval.title}` : `等你回答：${question?.questions[0]?.question ?? ""}`}
            </span>
            <span className="a-pending-go">查看</span>
          </button>
        ) : null}
        {plan && state === "running" ? <APlan items={plan} /> : null}
        <Composer id={id} />
      </div>
    </div>
  )
}

function APlan({ items }: { items: readonly PlanItem[] }) {
  const [open, setOpen] = useState(false)
  const progress = planProgress(items)
  return (
    <div className="a-plan" data-open={open || undefined}>
      <button type="button" className="a-plan-head" onClick={() => setOpen((value) => !value)}>
        <ListChecks className="ic" aria-hidden="true" />
        <span className="m-tabular">
          计划 {progress.done}/{progress.total}
        </span>
        {progress.current ? <span className="a-plan-current">正在：{progress.current}</span> : null}
        {open ? <ChevronDown className="ic" aria-hidden="true" /> : <ChevronUp className="ic" aria-hidden="true" />}
      </button>
      {open ? <PlanList items={items} /> : null}
    </div>
  )
}

function ADiff({ id, file }: { id: string; file?: string | undefined }) {
  const nav = useNav()
  return <DiffScreen id={id} file={file} onBack={() => nav.back({ screen: "thread", thread: id })} />
}

function ANew() {
  const nav = useNav()
  const form = useNewThreadForm()
  return (
    <div className="m-screen v-a">
      <NavBar
        left={
          <IconButton label="关闭" onClick={() => nav.back({ screen: "list" })}>
            <X className="ic" aria-hidden="true" />
          </IconButton>
        }
        title="新会话"
      />
      <div className="a-new">
        <h1>要做什么？</h1>
        <button type="button" className="a-project" onClick={() => form.setPicker("project")}>
          <Folder className="ic" aria-hidden="true" />
          {form.project.name}
          <ChevronDown className="ic" aria-hidden="true" />
        </button>
        <div className="a-chips">
          <button type="button" className="m-chip" onClick={() => form.setPicker("agent")}>
            {form.agent.name}
            <ChevronDown className="ic" aria-hidden="true" />
          </button>
          <button type="button" className="m-chip" onClick={() => form.setPicker("permission")}>
            {form.permission}
            <ChevronDown className="ic" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="m-dock">
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

function APair() {
  const nav = useNav()
  return (
    <div className="m-screen v-a">
      <PairingFlow onDone={() => nav.replace({ screen: "list" })} onCancel={() => nav.back({ screen: "list" })} />
    </div>
  )
}
