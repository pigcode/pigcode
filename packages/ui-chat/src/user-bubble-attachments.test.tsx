/** 验证时间线图片附件：纯图消息成轮、单张与多张网格、灯箱切图/缩放/Esc 关闭及 ChatView 接线。 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ImageAttachmentRef, Thread, ThreadEvent } from "@pigcode/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { ChatView } from "./chat-view"
import { buildTimeline } from "./turns"
import { UserBubble } from "./user-bubble"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function ref(
  id: string,
  fileName: string,
  width = 800,
  height = 600,
): ImageAttachmentRef {
  return {
    id,
    mimeType: "image/png",
    fileName,
    sizeBytes: 2048,
    width,
    height,
  }
}

function userEventMessage(
  seq: number,
  text: string,
  attachments?: ImageAttachmentRef[],
  runId = "run_1",
): ThreadEvent {
  return {
    seq,
    threadId: "t1",
    runId,
    type: "message.completed",
    payload: {
      role: "user",
      text,
      ...(attachments ? { attachments } : {}),
    },
    schemaVersion: 1,
    createdAt: "2026-11-25T10:00:00.000Z",
  }
}

describe("timeline attachments & UserBubble lightbox", () => {
  it("builds a turn for an image-only user message without dropping empty text", () => {
    const img = ref("att_1", "only-image.png", 600, 1200)
    const entries = buildTimeline([
      userEventMessage(1, "", [img]),
      {
        seq: 2,
        threadId: "t1",
        runId: "run_1",
        type: "message.completed",
        payload: { role: "assistant", text: "收到了这张长截图。" },
        schemaVersion: 1,
        createdAt: "2026-11-25T10:00:02.000Z",
      },
      {
        seq: 3,
        threadId: "t1",
        runId: "run_1",
        type: "run.completed",
        payload: {},
        schemaVersion: 1,
        createdAt: "2026-11-25T10:00:03.000Z",
      },
    ])
    expect(entries).toHaveLength(1)
    const turn = entries[0]?.kind === "turn" ? entries[0].turn : null
    expect(turn?.userText).toBeNull()
    expect(turn?.userAttachments).toEqual([img])
    expect(turn?.answer).toBe("收到了这张长截图。")
  })

  it("renders a single image with aspect ratio constraint and no empty text body on image-only messages", async () => {
    const readAttachment = vi.fn(
      async (id: string, variant: "thumb" | "full") => `data:image/png;base64,${id}-${variant}`,
    )
    const tall = ref("att_tall", "tall-shot.png", 1000, 2000)

    const { container } = render(
      <LocaleProvider locale="zh-CN">
        <UserBubble text="" attachments={[tall]} readAttachment={readAttachment} />
      </LocaleProvider>,
    )

    const grid = screen.getByRole("group", { name: "附件图片" })
    expect(grid.getAttribute("data-layout")).toBe("single")
    expect(container.querySelector(".msg-user-body")).toBeNull()
    expect(container.querySelector(".msg-user")?.getAttribute("data-images-only")).toBe("true")

    const button = screen.getByRole("button", { name: "查看图片 tall-shot.png" })
    expect(button.style.aspectRatio).toBe("1000 / 2000")
    expect(button.style.width).toBe("130px")

    await waitFor(() =>
      expect(readAttachment).toHaveBeenCalledWith("att_tall", "thumb"),
    )
    const img = await screen.findByAltText("tall-shot.png")
    expect(img.getAttribute("src")).toBe("data:image/png;base64,att_tall-thumb")
  })

  it("chooses 2-column grid for 2/4 images and 3-column grid for 3/5/6 images", () => {
    const cases: Array<[number, string]> = [
      [2, "grid-2"],
      [3, "grid-3"],
      [4, "grid-2"],
      [5, "grid-3"],
      [6, "grid-3"],
    ]
    for (const [count, expectedLayout] of cases) {
      const attachments = Array.from({ length: count }, (_, i) => ref(`att_${i}`, `img-${i}.png`))
      render(
        <LocaleProvider locale="zh-CN">
          <UserBubble text="多图测试" attachments={attachments} />
        </LocaleProvider>,
      )
      expect(screen.getByRole("group", { name: "附件图片" }).getAttribute("data-layout")).toBe(
        expectedLayout,
      )
      cleanup()
    }
  })

  it("opens the lightbox at the clicked index, switches with Arrow keys and buttons, zooms, and closes on Esc", async () => {
    const user = userEvent.setup()
    const readAttachment = vi.fn(
      async (id: string, variant: "thumb" | "full") => `data:image/png;base64,${id}-${variant}`,
    )
    const attachments = [
      ref("att_1", "first.png"),
      ref("att_2", "second.png"),
      ref("att_3", "third.png"),
    ]

    render(
      <LocaleProvider locale="zh-CN">
        <UserBubble text="请看这三张图" attachments={attachments} readAttachment={readAttachment} />
      </LocaleProvider>,
    )

    // 点击第二张图打开灯箱。
    await user.click(screen.getByRole("button", { name: "查看图片 second.png" }))
    const dialog = await screen.findByRole("dialog", { name: "图片预览" })
    expect(dialog.getAttribute("aria-modal")).toBe("true")
    expect(screen.getByTestId("lightbox-counter").textContent).toBe("2 / 3")
    expect(screen.getByText("second.png")).toBeTruthy()
    await waitFor(() => expect(readAttachment).toHaveBeenCalledWith("att_2", "full"))

    // 键盘右键切到第三张。
    fireEvent.keyDown(window, { key: "ArrowRight" })
    expect(screen.getByTestId("lightbox-counter").textContent).toBe("3 / 3")
    expect(screen.getByText("third.png")).toBeTruthy()
    await waitFor(() => expect(readAttachment).toHaveBeenCalledWith("att_3", "full"))

    // 键盘左键切回第二张，再点上一张按钮切到第一张。
    fireEvent.keyDown(window, { key: "ArrowLeft" })
    expect(screen.getByTestId("lightbox-counter").textContent).toBe("2 / 3")
    await user.click(screen.getByRole("button", { name: "上一张" }))
    expect(screen.getByTestId("lightbox-counter").textContent).toBe("1 / 3")

    // 缩放切换。
    await user.click(screen.getByRole("button", { name: "放大" }))
    expect(screen.getByRole("button", { name: "适应屏幕" }).textContent).toContain("125%")
    await user.click(screen.getByRole("button", { name: "适应屏幕" }))
    expect(screen.getByRole("button", { name: "适应屏幕" }).textContent).toContain("100%")

    // Esc 关闭灯箱。
    fireEvent.keyDown(window, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "图片预览" })).toBeNull())
  })

  it("renders attachments inside ChatView timeline and opens shared lightbox with full image", async () => {
    const user = userEvent.setup()
    const thread: Thread = {
      id: "t1",
      projectId: "p1",
      title: "图片会话",
      defaultAgentId: "claude",
      defaultInstanceId: null,
      lastAgentId: "claude",
      lastInstanceId: null,
      lastModelId: null,
      permissionMode: "full-access",
      createdAt: "2026-11-25T10:00:00.000Z",
      updatedAt: "2026-11-25T10:00:00.000Z",
      archivedAt: null,
      lastRunId: "run_1",
    }
    const readAttachment = vi.fn(
      async (id: string, variant: "thumb" | "full") => `data:image/png;base64,${id}-${variant}`,
    )

    render(
      <LocaleProvider locale="zh-CN">
        <ChatView
          thread={thread}
          events={[userEventMessage(1, "", [ref("att_mobile", "from-phone.png")])]}
          readAttachment={readAttachment}
        />
      </LocaleProvider>,
    )

    const openBtn = await screen.findByRole("button", { name: "查看图片 from-phone.png" })
    await user.click(openBtn)
    expect(await screen.findByRole("dialog", { name: "图片预览" })).toBeTruthy()
    await waitFor(() => expect(readAttachment).toHaveBeenCalledWith("att_mobile", "full"))

    await user.click(screen.getByRole("button", { name: "关闭预览" }))
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "图片预览" })).toBeNull())
  })
})
