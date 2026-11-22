// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Connection } from "@pigcode/client-runtime"
import { Composer } from "@pigcode/ui-composer"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { afterEach, expect, it, vi } from "vitest"
import { submitDesktopMessage } from "./desktop-message-recovery"
import { QueuedMessages } from "./queued-messages"

afterEach(cleanup)

it("keeps the original send ID after a lost reply and checks it before retrying", async () => {
  const startRun = vi.fn<Connection["startRun"]>().mockRejectedValueOnce(new Error("closed"))
  startRun.mockResolvedValue(undefined)
  const call = vi
    .fn<Connection["call"]>()
    .mockImplementation(async (method) =>
      method === "queue.get" ? { threadId: "thread", paused: false, messages: [] } : {},
    )
  const connection = { call, startRun } as unknown as Connection
  const fail = vi.fn()
  const renderQueue = (connected: boolean) => (
    <LocaleProvider locale="zh-CN">
      <QueuedMessages
        connection={connection}
        threadId="thread"
        events={[]}
        connected={connected}
        fail={fail}
      />
    </LocaleProvider>
  )
  const screenView = render(renderQueue(false))
  await act(async () => {
    await submitDesktopMessage(connection, "thread", "桌面原文", { effort: "high" }, fail)
  })
  expect(screen.queryByText("操作结果待确认")).not.toBeNull()
  const original = startRun.mock.calls[0]!
  expect(original[2]).toMatchObject({ commandId: expect.any(String), effort: "high" })

  screenView.rerender(renderQueue(true))
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith("command.receipt", {
      commandId: original[2]?.commandId,
    }),
  )
  expect(startRun).toHaveBeenCalledTimes(1)
  await userEvent.click(screen.getByRole("button", { name: "用原编号重试" }))
  await waitFor(() => expect(screen.queryByText("操作结果待确认")).toBeNull())
  expect(startRun.mock.calls).toEqual([original, original])
  expect(fail).not.toHaveBeenCalled()
})

it("recovers withdrawn text after leaving and reopening the conversation", async () => {
  let receipt: Record<string, unknown> | undefined
  const call = vi.fn<Connection["call"]>().mockImplementation(async (method, input) => {
    if (method === "queue.get") {
      return {
        threadId: "withdraw-thread",
        paused: true,
        messages: receipt ? [] : [{ id: "message", text: "等候发送的内容", selected: false }],
      }
    }
    if (method === "queue.withdraw") {
      receipt = { ...(input as object), method, effect: "withdrawn", text: "等候发送的内容" }
      throw new Error("closed")
    }
    return { receipt }
  })
  const connection = { call } as unknown as Connection
  const fail = vi.fn()
  const view = (
    <LocaleProvider locale="zh-CN">
      <QueuedMessages
        connection={connection}
        threadId="withdraw-thread"
        events={[]}
        connected
        fail={fail}
      />
      <Composer draftKey="withdraw-thread" onSubmit={() => undefined} onStop={() => undefined} />
    </LocaleProvider>
  )
  const screenView = render(view)
  await userEvent.click(await screen.findByRole("button", { name: "撤回" }))
  await screen.findByText("操作结果待确认")
  screenView.rerender(<div>另一条会话</div>)
  screenView.rerender(view)
  await waitFor(() =>
    expect(screenView.container.querySelector(".tiptap")?.textContent).toBe("等候发送的内容"),
  )
  expect(call.mock.calls.filter(([method]) => method === "queue.withdraw")).toHaveLength(1)
  expect(screen.queryByText("操作结果待确认")).toBeNull()
  expect(fail).not.toHaveBeenCalled()
})
