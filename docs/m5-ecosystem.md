# Pigcode M5：多会话与生态能力

M5 把 Pigcode 从“单线程工作台”扩展成可以同时处理多个会话的桌面客户端，并补齐
子 agent、MCP 工具、GitHub PR、本地预览和定时任务。本文说明这些能力的使用方式、
边界条件和验证命令；插件侧的工具注册细节见
[plugin-authoring.md](plugin-authoring.md)。

## 多会话与运行队列

### 线程 tab

- 从侧栏点击线程或以“新会话”创建线程时，该线程会以 tab 打开并立即订阅 Host 事件。
- 每个打开线程在 Renderer 中维护独立的 `ThreadViewState`：事件、流式文本、运行状态、
  待审批计数和最近错误。
- 切换 tab 只改变当前展示的线程；后台线程的 run 继续执行，事件仍通过同一个
  MessagePort 推送。
- 关闭 tab 会调用 `thread.unsubscribe`，释放 Host 侧监听器；不会中断正在运行的 run。
  关闭活动 tab 后会自动激活相邻 tab。
- tab 上的状态点对应 `run.queued`、`run.started`、`approval.requested`、
  `run.completed`、`run.failed`、`run.interrupted` 等事件，因此后台线程完成或
  等待审批时也能在非活动 tab 上看到提示。

### 队列

Host 的 `agents` 服务维护一个全局 FIFO 队列：

- 默认最多同时运行 4 个 run，默认最多排队 32 个 run。两个上限由 registry 的
  `AgentRunConfig`（`maxConcurrentRuns`、`maxQueuedRuns`）控制；桌面 profile
  当前没有暴露用户配置项。
- 达到并发上限时，`run.start` 仍然返回 `runId`，run 以 `queued` 状态进入队列，
  并追加一条 `run.queued` 事件；此时不抛 `TOO_MANY_ACTIVE_RUNS`。
- 队列已满时抛 `RunQueueFullError`。同一线程在运行或排队期间再次 `run.start`
  仍抛 `RunAlreadyActiveError`，保证一个线程同时只有一个 run。
- 一个 run 进入终态后，队列按 FIFO 自动启动下一个。
- 取消排队中的 run 会把它置为 `interrupted`、追加 `run.interrupted`、释放线程，
  并且不会执行 driver。运行中的 run 仍走原有的中断流程。

相关 RPC：

| 命令                 | 参数                  | 返回                                                      |
| -------------------- | --------------------- | --------------------------------------------------------- |
| `run.start`          | `{ threadId, text }`  | `{ runId }`                                               |
| `run.list`           | `{}`                  | `{ runs: Array<{ runId, threadId, status, queuedAt? }> }` |
| `run.interrupt`      | `{ threadId, runId }` | `{ interrupted }`                                         |
| `thread.unsubscribe` | `{ threadId }`        | `{ ok: true }`                                            |

`run.list` 同时包含运行中与排队中的 run；`queuedAt` 只对排队中的 run 存在。

## 子 agent 时间线

子 agent 事件由各 Agent driver 的事件归一化产生，Renderer 将其渲染为可折叠卡片：

- `subagent.started`：`{ toolCallId, name, description?, model?, parentToolUseId? }`
- `subagent.completed`：`{ toolCallId, output?, isError, status }`，`status` 为
  `completed`、`failed` 或 `interrupted`

`message.delta`、`message.completed`、`tool.started`、`tool.completed` 可以携带
`parentToolUseId`，表示该内容属于某个子 agent。`MessageList` 会把这些事件归入对应
卡片，不再作为主时间线的顶层消息；卡片默认折叠，点击 `<summary>` 展开子消息与工具
调用。父 run 仍然只产生一次 `run.completed`。

两个 Agent 的来源不同：

- **Claude**：`Task` / `Agent` 的 `tool_use` 产生 `subagent.started`；driver 开启
  `forwardSubagentText`，带 `parent_tool_use_id` 的文本和工具事件携带
  `parentToolUseId`；对应的 `tool_result` 产生 `subagent.completed`，`isError` 取
  `block.is_error`。
- **Codex**：`subAgentActivity` 的 `kind: "started"` 产生 `subagent.started`，
  `completed` / `interrupted` 产生 `subagent.completed`；`collabAgentToolCall` /
  `collabToolCall` 会按 `receiverThreadIds` 逐个产生子 agent 卡片。

## MCP 工具（Capability 插件）

Capability 插件通过 `ctx.mcp.registerTool` 把自己的工具暴露给模型。工具的
`inputSchema` 使用 JSON Schema，handler 的第二个参数带有调用方的线程上下文：

```js
/** 示例：返回当前时间的 Capability 插件。 */
export const name = "capability-clock"
export const inject = ["mcp"]

export function apply(ctx) {
  ctx.effect(() =>
    ctx.mcp.registerTool(
      "pigcode-capability-clock",
      {
        name: "clock_now",
        description: "Return the current ISO time",
        inputSchema: { type: "object", properties: {} },
      },
      async (_input, { threadId }) => ({ now: new Date().toISOString(), threadId }),
    ),
  )
}
```

完整示例见 [`examples/capability-clock`](../examples/capability-clock)。返回值必须可
JSON 序列化；Host 会把它转成 MCP 的文本内容交给模型。工具名不存在时 `callTool` 抛
`unknown mcp tool: <name>`。插件停用或卸载时，`ctx.effect` 返回的 disposer 会注销工具，
工具随即从列表和后续会话中消失。

### 注入方式与线程隔离

- **Claude**：Host 用 `createSdkMcpServer` 为每次会话创建进程内 MCP server，名称为
  `pigcode`，通过 `query()` 的 `mcpServers` 注入。server 的 handler 闭包绑定当前
  `threadId`。
- **Codex**：Host 生成 `config.mcp_servers.pigcode`，command 为 Host 自己的可执行文件（靠
  `ELECTRON_RUN_AS_NODE` 当 Node 用，不依赖系统的 node），参数指向
  `mcp/stdio-bridge.mjs`，并通过环境变量传入 Unix socket 路径（Windows 为命名管道）
  和一次性 token。`thread/start` 与 `thread/resume` 都会带上该配置。stdio bridge 在
  `hello` 时用 token 映射回线程，之后 `tools/list`、`tools/call` 都只在该线程作用域内
  执行。
- 工具注册表是 Host 全局的，因此所有插件工具对所有线程可见；隔离发生在**调用**层：
  handler 收到的 `threadId` 始终是发起该 run 的线程，不会跨线程共享可变调用状态。
- 没有任何注册工具时，`sessionMcp()` 返回 `undefined`，Agent 不会注入空配置。
- 跨进程通信只使用 stdio 与 Unix domain socket / 命名管道，不监听 TCP 端口。

## GitHub PR

PR 集成只调用 `gh` CLI，不读取、保存或传递 GitHub token。

前置条件：

- 安装 GitHub CLI，并确保 `gh` 在 PATH 中。
- 执行过 `gh auth login`，当前账号对仓库有权限。
- 线程的 cwd（活动 worktree 或项目根目录）是一个有远端仓库的 Git 工作区，
  且当前不在 detached HEAD。

RPC：

| 命令        | 参数                                | 返回                      |
| ----------- | ----------------------------------- | ------------------------- |
| `pr.status` | `{ threadId }`                      | `PullRequestInfo \| null` |
| `pr.create` | `{ threadId, title, body?, base? }` | `PullRequestInfo`         |

`status` 先读取当前分支，再执行
`gh pr view <branch> --json number,url,state,title,headRefName,baseRefName`；分支没有
关联 PR 时返回 `null`。`create` 执行
`gh pr create --head <branch> --title <title> --body <body> --json ...`，`base` 只在
显式提供时传给 `gh`。返回值包含 `number`、`url`、`state`（`OPEN` / `CLOSED` /
`MERGED`）、`title`、`headRefName`、`baseRefName`。

错误码：

- `GH_NOT_AVAILABLE`：找不到 `gh` 可执行文件，错误信息提示安装 GitHub CLI。
- `GH_NOT_AUTHENTICATED`：`gh` 未登录，错误信息提示执行 `gh auth login`。
- `GH_COMMAND_FAILED`：其他 `gh` 失败或输出无法解析。

右栏的 PR tab 可以填写标题和描述创建 PR，并展示当前分支的 PR 状态。

## 本地浏览器预览

预览只允许 loopback 地址：

- 协议必须是 `http` 或 `https`。
- 主机名必须是 `localhost`、`127.0.0.1` 或 `[::1]`。
- 远程主机、`file://`、`javascript:`、空串等非法输入会被拒绝，并抛出
  `PREVIEW_URL_NOT_ALLOWED`。

窗口内的导航、302 重定向、子框架导航和 `window.open` 使用同一规则：离开 loopback 的
跳转会被拦截，指向远程主机的弹窗被拒绝；`about:blank` 弹窗可以打开，它之后的跳转同样受限。

合法的 URL 通过 preload 的 `previewOpen(url)` 打开一个独立的 Electron 窗口：
`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
`previewClose(id?)` 关闭指定窗口，省略 `id` 时关闭全部。Renderer 不内嵌 iframe，
预览窗口与主界面进程隔离。右栏的 preview tab 提供 URL 输入（默认
`http://localhost:3000`）、打开按钮和错误提示。

## 定时任务

定时任务以固定间隔（秒）重复运行，不支持 cron 表达式。

- 间隔必须是正整数且不超过 `2_147_483` 秒（约 24.8 天）；更大的值会超过
  Node `setTimeout` 的 32 位上限并被截断成 1ms。
- 任务持久化在 SQLite 的 `schedules` 表（migration 4），包含线程、prompt、
  间隔、启用状态、`next_run_at`、`last_run_at` 和 `last_run_id`。
- 创建时 `next_run_at = now + intervalSeconds`；每次触发后从当前时间重新计算下一次。
- Host 启动时读取所有启用任务并重新装载 timer。Host 退出期间不会触发；如果
  `next_run_at` 已过期，启动后只补跑一次，然后按间隔继续。
- 线程已有运行中或排队中的 run 时视为忙：本次跳过，只推进 `next_run_at`，
  `last_run_at` / `last_run_id` 保持不变。因此同一线程不会因为定时任务产生并发 run。
- 触发使用 `setTimeout` 链，并避免同一任务重入；`stop()` 清理全部 timer，
  随 Host 服务 dispose 自动执行。
- 删除或停用任务会清除对应 timer，之后不会再触发。

RPC：

| 命令              | 参数                                              | 返回                        |
| ----------------- | ------------------------------------------------- | --------------------------- |
| `schedule.list`   | `{}`                                              | `Schedule[]`                |
| `schedule.create` | `{ threadId, prompt, intervalSeconds, enabled? }` | `Schedule`                  |
| `schedule.update` | `{ id, prompt?, intervalSeconds?, enabled? }`     | `Schedule`                  |
| `schedule.delete` | `{ id }`                                          | `{ deleted }`               |
| `schedule.runNow` | `{ id }`                                          | `{ runId: string \| null }` |

`runNow` 在线程忙或 Agent 不可用时返回 `runId: null`。桌面端在
**设置 → 定时任务** 中管理任务、启停和立即运行。

## Agent 切换：原生 fork 优先

切换用 `thread.switchAgent`（参数 `{ threadId, agentId, modelId? }`）。同一 Agent 内切换模型时，
如果线程存在活动的原生会话，Host 写入 `forkFromNativeSessionId`，下一次 run 让 Agent 原生 fork
该会话，不注入 handoff 文本。换 Agent 时改为生成 handoff：最近 3 条 user/assistant 文本和最近 3 个
工具名，只在下一次 run 注入一次。两种标记都通过 `thread.updated` 事件持久化，并在
`run.started` 之前读取。

## 真实 Codex 多会话测试

真实测试默认跳过，只有显式设置 `PIGCODE_REAL_CODEX=1` 才执行，且使用
`gpt-6.1-sol` 模型：

```bash
cd frontend
PIGCODE_REAL_CODEX=1 PIGCODE_CODEX_MODEL=gpt-6.1-sol pnpm real:codex:multi
```

`apps/host/src/agents/multi-session.real.test.ts` 会创建两个 Codex 线程，
用 `Promise.all` 并行启动两个 run，分别发送 `Reply with exactly OK-1` 和
`Reply with exactly OK-2`，等待两个 `done` 后断言两个 run 都是 `completed`，且各自
线程的 assistant 文本包含 `OK-1` / `OK-2`。测试结束会中断残留 turn 并 dispose
app-server 子进程。

真实 Codex E2E（`apps/desktop/e2e/m5-real-codex.spec.ts`）同样受
`PIGCODE_REAL_CODEX=1` 控制。它逐线程验证 UI 链路，因为真实模型同时跑两个 turn
可能触发模型服务的容量限制；两个真实 run 的并行覆盖以上面的 vitest 为准。

## 确定性验收

```bash
cd frontend
pnpm test
pnpm lint
pnpm typecheck
```

E2E：

```bash
cd frontend/apps/desktop
PIGCODE_E2E=1 pnpm exec playwright test \
  e2e/m0-b.spec.ts \
  e2e/m3-workbench.spec.ts \
  e2e/m4-plugins.spec.ts \
  e2e/m5-multi-session.spec.ts
```

`m5-multi-session.spec.ts` 使用 fake agent，并通过 `PIGCODE_FAKE_DELAY_MS=800`
制造可观察的后台运行窗口，覆盖：两个 tab 同时打开、切换 tab 后后台线程继续运行、
完成后切回看到结果、关闭后台 tab 与关闭活动 tab。视觉基线如有变化，需要在同一
提交中更新并说明原因。
