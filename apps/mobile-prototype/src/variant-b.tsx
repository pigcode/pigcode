/**
 * 方案 B「按项目 + 标签栏」：底部三个标签（会话 / 需要处理 / 电脑）；会话按项目分组，和桌面侧栏一样；
 * 会话里用分段控件切「对话 / 改动 / 计划」；审批和提问从底部弹出，也可以在「需要处理」里跨会话连着处理。
 */
import { useState } from "react"
import { ChevronRight, Inbox, Laptop, MessagesSquare, Plus, Search } from "lucide-react"
import { StatusDot, Switch } from "@pigcode/ui-primitives"
import {
  ApprovalBody,
  BackButton,
  Composer,
  ComputerDetails,
  ConnLabel,
  connInfo,
  DiffScreen,
  FileList,
  IconButton,
  NavBar,
  PairingFlow,
  PickList,
  PlanList,
  planProgress,
  QuestionBody,
  RowBadge,
  Sheet,
  stateText,
  Timeline,
  useNewThreadForm,
  useOpenThread,
  type Picker,
} from "./common"
import { COMPUTER, PROJECTS, project } from "./data"
import { useNav } from "./nav"
import { useProto } from "./store"

type Tab = "threads" | "inbox" | "computer"

export function VariantB() {
  const { place } = useNav()
  if (place.screen === "thread" && place.thread) return <BThread id={place.thread} />
  if (place.screen === "diff" && place.thread) return <BDiff id={place.thread} file={place.file} />
  const tab: Tab =
    place.screen === "inbox" ? "inbox" : place.screen === "computer" || place.screen === "pair" ? "computer" : "threads"
  return (
    <div className="m-screen v-b">
      <div className="b-body">{tab === "threads" ? <BThreads /> : tab === "inbox" ? <BInbox /> : <BComputer />}</div>
      <BTabBar tab={tab} />
    </div>
  )
}

function BTabBar({ tab }: { tab: Tab }) {
  const store = useProto()
  const nav = useNav()
  const { attention } = store.counts()
  return (
    <nav className="b-tabbar">
      <button type="button" className="b-tab" data-active={tab === "threads" || undefined} onClick={() => nav.replace({ screen: "list" })}>
        <MessagesSquare className="ic" aria-hidden="true" />
        会话
      </button>
      <button type="button" className="b-tab" data-active={tab === "inbox" || undefined} onClick={() => nav.replace({ screen: "inbox" })}>
        <Inbox className="ic" aria-hidden="true" />
        需要处理
        {attention > 0 && store.conn !== "offline" ? <span className="b-tab-badge">{attention}</span> : null}
      </button>
      <button type="button" className="b-tab" data-active={tab === "computer" || undefined} onClick={() => nav.replace({ screen: "computer" })}>
        <Laptop className="ic" aria-hidden="true" />
        电脑
        <StatusDot tone={connInfo(store.conn).tone} className="b-tab-dot" />
      </button>
    </nav>
  )
}

function BThreads() {
  const store = useProto()
  const nav = useNav()
  const [query, setQuery] = useState("")
  const form = useNewThreadForm()
  const [sub, setSub] = useState<Picker | null>(null)
  const newOpen = nav.place.screen === "new"

  return (
    <>
      <NavBar
        title="会话"
        left={<ConnLabel conn={store.conn} />}
        right={
          <IconButton label="新会话" onClick={() => nav.go({ screen: "new" })}>
            <Plus className="ic" aria-hidden="true" />
          </IconButton>
        }
      />
      <label className="b-search">
        <Search className="ic" aria-hidden="true" />
        <input value={query} placeholder="搜索会话" onChange={(event) => setQuery(event.target.value)} />
      </label>
      {store.conn !== "online" ? (
        <div className="b-banner" data-conn={store.conn}>
          {store.conn === "offline"
            ? `电脑离线，下面是 ${COMPUTER.lastSeen} 的结果。电脑醒来后自动重连。`
            : "正在重新连接电脑，列表可能不是最新的。"}
        </div>
      ) : null}
      <div className="m-scroll">
        {PROJECTS.map((item) => {
          const ids = store.order.filter(
            (id) => store.meta[id]?.projectId === item.id && store.meta[id]!.title.includes(query.trim()),
          )
          if (ids.length === 0) return null
          return (
            <section key={item.id}>
              <h3 className="b-section-head">
                {item.name}
                <span className="m-count">{ids.length}</span>
              </h3>
              <ul className="b-rows">
                {ids.map((id) => {
                  const meta = store.meta[id]!
                  return (
                    <li key={id}>
                      <button type="button" className="b-row" onClick={() => nav.go({ screen: "thread", thread: id })}>
                        <span className="b-row-title">{meta.title}</span>
                        <RowBadge state={store.stateOf(id)} conn={store.conn} />
                        <span className="b-row-time">{meta.time}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>
      <Sheet open={newOpen} tall title={sub ? undefined : "新会话"} onClose={() => (sub ? setSub(null) : nav.back({ screen: "list" }))}>
        {sub ? (
          <div className="b-sub">
            <BackButton label="新会话" onClick={() => setSub(null)} />
            <PickList
              items={form.items[sub]}
              value={form.values[sub]}
              onPick={(value) => {
                form.pick(sub, value)
                setSub(null)
              }}
            />
          </div>
        ) : (
          <div className="b-form">
            <dl className="m-rows m-rows-tap">
              {(
                [
                  ["project", "项目", form.project.name],
                  ["agent", "Agent 实例", form.agent.name],
                  ["model", "模型", form.model],
                  ["permission", "权限模式", form.permission],
                ] as const
              ).map(([kind, label, value]) => (
                <div key={kind} role="button" tabIndex={0} onClick={() => setSub(kind)}>
                  <dt>{label}</dt>
                  <dd>
                    {value}
                    <ChevronRight className="ic" aria-hidden="true" />
                  </dd>
                </div>
              ))}
            </dl>
            <Composer id="new" placeholder="要做什么？" onSend={form.submit} />
          </div>
        )}
      </Sheet>
    </>
  )
}

function BInbox() {
  const store = useProto()
  const nav = useNav()
  const ids = store.order.filter((id) => store.needsAttention(id))
  return (
    <>
      <NavBar title="需要处理" />
      <div className="m-scroll b-inbox">
        {store.conn === "offline" ? <div className="b-banner" data-conn="offline">电脑离线，连上之后才能处理。</div> : null}
        {ids.length === 0 ? <div className="m-empty">没有需要你处理的事</div> : null}
        {ids.map((id) => {
          const meta = store.meta[id]!
          const state = store.stateOf(id)
          const approval = store.pendingApproval(id)
          const question = store.pendingQuestion(id)
          const files = store.files(id)
          return (
            <article key={id} className="b-card">
              <header className="b-card-head">
                <span className="b-card-title">{meta.title}</span>
                <span>
                  {project(meta.projectId).name} · {meta.time}
                </span>
              </header>
              {approval ? (
                <ApprovalBody approval={approval} compact onDecide={(decision) => store.resolveApproval(id, approval.requestId, decision)} />
              ) : question ? (
                <QuestionBody question={question} compact onAnswer={(answers) => store.answerQuestion(id, question.requestId, answers)} />
              ) : (
                <p className="b-card-done">
                  {stateText(state)} · 跑完了还没看
                  {files.length > 0 ? ` · 改了 ${files.length} 个文件` : ""}
                </p>
              )}
              <button type="button" className="b-card-open" onClick={() => nav.go({ screen: "thread", thread: id })}>
                打开会话
                <ChevronRight className="ic" aria-hidden="true" />
              </button>
            </article>
          )
        })}
      </div>
    </>
  )
}

function BComputer() {
  const nav = useNav()
  const [alerts, setAlerts] = useState({ done: true, failed: true, approval: true, question: true })
  const rows: Array<[keyof typeof alerts, string]> = [
    ["done", "一轮跑完"],
    ["failed", "出错或被停下"],
    ["approval", "等你确认"],
    ["question", "向你提问"],
  ]
  return (
    <>
      <NavBar title="电脑" />
      <div className="m-scroll b-computer">
        <ComputerDetails onPair={() => nav.go({ screen: "pair" })} />
        <section className="b-settings">
          <h3>通知</h3>
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
        </section>
      </div>
      <Sheet open={nav.place.screen === "pair"} tall onClose={() => nav.back({ screen: "computer" })}>
        <PairingFlow onDone={() => nav.replace({ screen: "computer" })} onCancel={() => nav.back({ screen: "computer" })} />
      </Sheet>
    </>
  )
}

type Segment = "chat" | "files" | "plan"

function BThread({ id }: { id: string }) {
  useOpenThread(id)
  const store = useProto()
  const nav = useNav()
  const [segment, setSegment] = useState<Segment>("chat")
  const [dismissed, setDismissed] = useState<string | null>(null)
  const meta = store.meta[id]
  if (!meta) return null
  const files = store.files(id)
  const plan = store.plans[id]
  const approval = store.pendingApproval(id)
  const question = store.pendingQuestion(id)
  const pending = approval?.requestId ?? question?.requestId
  const sheetOpen = Boolean(pending) && dismissed !== pending && segment === "chat"
  const progress = plan ? planProgress(plan) : undefined

  return (
    <div className="m-screen v-b">
      <NavBar
        left={<BackButton label="会话" onClick={() => nav.back({ screen: "list" })} />}
        title={meta.title}
        subtitle={store.conn === "online" ? `${project(meta.projectId).name} · ${meta.agent}` : <ConnLabel conn={store.conn} />}
      />
      <div className="b-seg" role="tablist">
        <button type="button" role="tab" data-active={segment === "chat" || undefined} onClick={() => setSegment("chat")}>
          对话
        </button>
        <button type="button" role="tab" data-active={segment === "files" || undefined} onClick={() => setSegment("files")}>
          改动{files.length > 0 ? ` ${files.length}` : ""}
        </button>
        {progress ? (
          <button type="button" role="tab" data-active={segment === "plan" || undefined} onClick={() => setSegment("plan")}>
            计划 {progress.done}/{progress.total}
          </button>
        ) : null}
      </div>
      {segment === "chat" ? (
        <>
          <Timeline id={id} onViewDiff={(path) => nav.go({ screen: "diff", thread: id, file: path })} />
          <div className="m-dock">
            {pending && !sheetOpen ? (
              <button type="button" className="b-pending" onClick={() => setDismissed(null)}>
                {approval ? "1 个待确认" : "1 个待回答"}
                <ChevronRight className="ic" aria-hidden="true" />
              </button>
            ) : null}
            <Composer id={id} />
          </div>
        </>
      ) : segment === "files" ? (
        <div className="m-scroll">
          <FileList id={id} onOpen={(path) => nav.go({ screen: "diff", thread: id, file: path })} />
        </div>
      ) : (
        <div className="m-scroll b-plan">{plan ? <PlanList items={plan} /> : null}</div>
      )}
      <Sheet open={sheetOpen} title={approval ? "等你确认" : "等你回答"} onClose={() => setDismissed(pending ?? null)}>
        {approval ? (
          <ApprovalBody approval={approval} onDecide={(decision) => store.resolveApproval(id, approval.requestId, decision)} />
        ) : question ? (
          <QuestionBody question={question} onAnswer={(answers) => store.answerQuestion(id, question.requestId, answers)} />
        ) : null}
      </Sheet>
    </div>
  )
}

function BDiff({ id, file }: { id: string; file?: string | undefined }) {
  const nav = useNav()
  return <DiffScreen id={id} file={file} onBack={() => nav.back({ screen: "thread", thread: id })} />
}
