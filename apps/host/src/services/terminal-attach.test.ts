/** 验证 terminal 服务的 list、rebind、attach 增量回滚、淘汰策略与来源元数据。 */
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createTerminalHarness, fakePty } from "./terminal-test-harness"

const harness = createTerminalHarness()

afterEach(async () => {
  await harness.cleanup()
})

describe("terminal service attach and scrollback", () => {
  it("lists active terminals by creation order, thread, or draft project with live metadata", async () => {
    const pty = fakePty()
    const { ctx, project, thread } = await harness.setup(pty)
    const otherThread = ctx.threads.create(project.id, "Other", "fake")

    const draft = await ctx.terminal.open({ projectId: project.id }, 80, 24, {
      placement: "drawer",
    })
    const first = await ctx.terminal.open({ threadId: thread.id }, 90, 25, {
      placement: "drawer",
    })
    const second = await ctx.terminal.open({ threadId: thread.id }, 100, 30, {
      placement: "workbench",
    })
    const third = await ctx.terminal.open({ threadId: otherThread.id }, 80, 24)

    expect(draft.cursor).toBe(0)
    expect(draft.placement).toBe("drawer")
    expect(Number.isNaN(Date.parse(draft.createdAt))).toBe(false)
    expect(third.placement).toBeUndefined()

    ctx.terminal.resize(first.id, 132, 42)
    pty.emit("hello", 1)

    expect(ctx.terminal.list().map((item) => item.id)).toEqual([
      draft.id,
      first.id,
      second.id,
      third.id,
    ])
    expect(ctx.terminal.list({ threadId: thread.id })).toEqual([
      expect.objectContaining({
        id: first.id,
        cols: 132,
        rows: 42,
        cursor: 5,
        placement: "drawer",
      }),
      expect.objectContaining({
        id: second.id,
        cols: 100,
        rows: 30,
        cursor: 0,
        placement: "workbench",
      }),
    ])
    expect(ctx.terminal.list({ projectId: project.id }).map((item) => item.id)).toEqual([draft.id])

    ctx.terminal.close(second.id)
    expect(ctx.terminal.list({ threadId: thread.id }).map((item) => item.id)).toEqual([first.id])
  })

  it("rebinds a draft terminal to a thread in the same project and rejects cross-project rebinds", async () => {
    const pty = fakePty()
    const { ctx, project, thread } = await harness.setup(pty)
    const otherRoot = await mkdtemp(join(tmpdir(), "pigcode-terminal-rebind-"))
    harness.roots.push(otherRoot)
    const otherProject = ctx.projects.add(otherRoot)
    const otherThread = ctx.threads.create(otherProject.id, "Other Project", "fake")
    const secondThread = ctx.threads.create(project.id, "Same Project 2", "fake")

    const draft = await ctx.terminal.open({ projectId: project.id }, 80, 24, {
      placement: "drawer",
    })
    expect(ctx.terminal.list({ projectId: project.id }).map((item) => item.id)).toEqual([draft.id])
    expect(ctx.terminal.list({ threadId: thread.id })).toEqual([])

    expect(() => ctx.terminal.rebind(draft.id, "th_missing")).toThrow("thread not found")
    expect(() => ctx.terminal.rebind(draft.id, otherThread.id)).toThrow(/project/i)
    expect(() => ctx.terminal.rebind("term_missing", thread.id)).toThrow("terminal not found")

    const rebound = ctx.terminal.rebind(draft.id, thread.id)
    expect(rebound).toMatchObject({ id: draft.id, threadId: thread.id, projectId: project.id })
    expect(ctx.terminal.list({ projectId: project.id })).toEqual([])
    expect(ctx.terminal.list({ threadId: thread.id }).map((item) => item.id)).toEqual([draft.id])

    // 幂等改绑同一线程允许；跨线程抢占拒绝。
    expect(ctx.terminal.rebind(draft.id, thread.id).threadId).toBe(thread.id)
    expect(() => ctx.terminal.rebind(draft.id, secondThread.id)).toThrow(/already bound/i)

    // 改绑后归档/关闭该线程能够正确关闭这个终端。
    ctx.terminal.closeThread(thread.id)
    expect(pty.killCount).toBe(1)
  })

  it("replays full and incremental scrollback on attach with zero overlap or gap", async () => {
    const pty = fakePty()
    const { ctx, thread } = await harness.setup(pty)
    const opened = await ctx.terminal.open({ threadId: thread.id }, 80, 24)
    ctx.terminal.resize(opened.id, 110, 36)

    pty.emit("line1\n")
    pty.emit("line2\n")

    const live: Array<{ data: string; cursor: number }> = []
    const exits: number[] = []
    const firstAttach = ctx.terminal.attach(
      opened.id,
      (data, cursor) => live.push({ data, cursor }),
      (code) => exits.push(code),
    )
    expect(firstAttach.replay).toBe("line1\nline2\n")
    expect(firstAttach.cursor).toBe(12)
    expect(firstAttach.truncated).toBe(false)
    expect(firstAttach.session).toMatchObject({ cols: 110, rows: 36, cursor: 12 })

    // attach 后新输出只通过 live 回调到达，且 cursor 连续递增。
    pty.emit("line3\n")
    expect(live).toEqual([{ data: "line3\n", cursor: 18 }])
    firstAttach.unsubscribe()

    // 增量重放：从分片内部游标切出剩余部分，无重复无遗漏。
    const incremental = ctx.terminal.attach(opened.id, () => undefined, undefined, 3)
    expect(incremental.replay).toBe("e1\nline2\nline3\n")
    expect(incremental.cursor).toBe(18)
    expect(incremental.truncated).toBe(false)
    incremental.unsubscribe()

    // 游标已经在最新位置时重放为空串。
    const caughtUp = ctx.terminal.attach(opened.id, () => undefined, undefined, 18)
    expect(caughtUp.replay).toBe("")
    expect(caughtUp.cursor).toBe(18)
    expect(caughtUp.truncated).toBe(false)
    caughtUp.unsubscribe()

    // 非法游标抛错。
    expect(() => ctx.terminal.attach(opened.id, () => undefined, undefined, -1)).toThrow(/cursor/i)
    expect(() => ctx.terminal.attach(opened.id, () => undefined, undefined, 1.5)).toThrow(/cursor/i)

    // 退出事件正常触达仍在监听的订阅者。
    const onExitAttach = ctx.terminal.attach(
      opened.id,
      () => undefined,
      (code) => exits.push(code),
    )
    pty.exit(42)
    expect(exits).toEqual([42])
    onExitAttach.unsubscribe()
  })

  it("evicts oldest chunks beyond scrollbackBytes and preserves UTF-16 surrogate pairs on oversize chunks", async () => {
    const pty = fakePty()
    const { ctx, thread } = await harness.setup(pty, { scrollbackBytes: 8 })
    const opened = await ctx.terminal.open({ threadId: thread.id }, 80, 24)

    pty.emit("aaaa") // [0, 4) -> 4B
    pty.emit("bbbb") // [4, 8) -> 8B
    pty.emit("cccc") // [8, 12) -> 丢弃 aaaa，保留 bbbbcccc (8B)，startCursor = 4

    const fromZero = ctx.terminal.attach(opened.id, () => undefined, undefined, 0)
    expect(fromZero.replay).toBe("bbbbcccc")
    expect(fromZero.cursor).toBe(12)
    expect(fromZero.truncated).toBe(true)
    fromZero.unsubscribe()

    const fromStart = ctx.terminal.attach(opened.id, () => undefined, undefined, 4)
    expect(fromStart.replay).toBe("bbbbcccc")
    expect(fromStart.truncated).toBe(false)
    fromStart.unsubscribe()

    // 单片超过 8 字节上限：包含 4 字节 emoji（2 UTF-16 码元）与 ASCII。
    // "xy😀z" = 1 + 1 + 4 + 1 = 7B；"abcdef😀z" = 6 + 4 + 1 = 11B > 8B
    // 末尾最多保留 8B：'z'(1B) + '😀'(4B) + 'f'(1B) + 'e'(1B) + 'd'(1B) = 8B => "def😀z"
    pty.emit("abcdef😀z") // 原长度 9（a..f 6 + 😀 2 + z 1），endCursor = 21
    const afterEmoji = ctx.terminal.attach(opened.id, () => undefined, undefined, 0)
    expect(afterEmoji.replay).toBe("def😀z")
    expect(afterEmoji.cursor).toBe(21)
    expect(afterEmoji.truncated).toBe(true)
    expect(Buffer.byteLength(afterEmoji.replay, "utf8")).toBeLessThanOrEqual(8)
    afterEmoji.unsubscribe()

    // 再测试刚好卡在 emoji 中间字节的情况：
    // "0123😀4567" = 4 + 4 + 4 = 12B > 8B；末尾 8B 应该是 "😀4567" (4 + 4 = 8B)
    // 而 "0123😀45678" = 4 + 4 + 5 = 13B > 8B；末尾 5B 是 "45678"，再加 emoji 会变成 9B > 8B，
    // 因此必须跳过整个 emoji，只保留 "45678"，不能切裂代理对产生孤立低代理！
    pty.emit("0123😀45678") // length = 4 + 2 + 5 = 11，endCursor = 32
    const boundary = ctx.terminal.attach(opened.id, () => undefined, undefined, 0)
    expect(boundary.replay).toBe("45678")
    expect(boundary.cursor).toBe(32)
    expect(boundary.truncated).toBe(true)
    // 确保不包含孤立代理码元
    for (let i = 0; i < boundary.replay.length; i += 1) {
      const code = boundary.replay.charCodeAt(i)
      expect(code < 0xd800 || code > 0xdfff).toBe(true)
    }
    boundary.unsubscribe()

    // 增量重放游标若落在代理对中间（如 "😀a" 偏移 1），也不切裂代理对。
    pty.emit("😀a") // [32, 35)，其中 32 是高代理、33 是低代理、34 是 'a'
    const midSurrogate = ctx.terminal.attach(opened.id, () => undefined, undefined, 33)
    expect(midSurrogate.replay).toBe("a")
    expect(midSurrogate.cursor).toBe(35)
    midSurrogate.unsubscribe()
  })

  it("defaults origin to desktop and preserves explicit mobile origin across list and attach", async () => {
    const pty = fakePty()
    const { ctx, thread } = await harness.setup(pty)

    const desktopTerm = await ctx.terminal.open({ threadId: thread.id }, 80, 24)
    const mobileTerm = await ctx.terminal.open({ threadId: thread.id }, 48, 20, {
      origin: "mobile",
    })

    expect(desktopTerm.origin).toBe("desktop")
    expect(mobileTerm.origin).toBe("mobile")
    expect(ctx.terminal.list({ threadId: thread.id }).map((t) => [t.id, t.origin])).toEqual([
      [desktopTerm.id, "desktop"],
      [mobileTerm.id, "mobile"],
    ])

    const attached = ctx.terminal.attach(mobileTerm.id, () => undefined)
    expect(attached.session.origin).toBe("mobile")
    attached.unsubscribe()
  })
})
