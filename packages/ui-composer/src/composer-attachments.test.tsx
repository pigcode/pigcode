/** 验证输入框图片附件：粘贴截图、纯文本粘贴不退化、拖放高亮与添加、+ 菜单多选与 6 张上限、纯图发送、不支持看图轻提示、删除与失败重试。 */
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ImageAttachmentRef } from "@pigcode/contracts"
import type { ComponentProps } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { Composer } from "./composer"
import { appendComposerText, moveComposerDraft, resetComposerMemory } from "./composer-memory"
import { TEST_MODES } from "./permission-fixture"

afterEach(() => {
  cleanup()
  resetComposerMemory()
  vi.restoreAllMocks()
})

function makePng(name = "shot.png", size = 16): File {
  const bytes = new Uint8Array(size)
  bytes[0] = 0x89
  bytes[1] = 0x50
  return new File([bytes], name, { type: "image/png" })
}

function makeRef(id: string, fileName = "shot.png"): ImageAttachmentRef {
  return {
    id,
    mimeType: "image/png",
    fileName,
    sizeBytes: 16,
    width: 320,
    height: 180,
  }
}

function renderComposer(props: Partial<ComponentProps<typeof Composer>> = {}) {
  let seq = 0
  const onUploadImage =
    props.onUploadImage ??
    vi.fn(async (input) => makeRef(`att_${++seq}`, input.fileName ?? "image.png"))
  const onSubmit = props.onSubmit ?? vi.fn()
  const view = render(
    <LocaleProvider locale="zh-CN">
      <Composer
        executionModes={TEST_MODES}
        onSubmit={onSubmit}
        onStop={() => {}}
        onUploadImage={onUploadImage}
        {...props}
      />
    </LocaleProvider>,
  )
  return {
    ...view,
    editor: screen.getByRole("textbox"),
    onUploadImage,
    onSubmit,
    rerenderWith: (next: Partial<ComponentProps<typeof Composer>>) =>
      view.rerender(
        <LocaleProvider locale="zh-CN">
          <Composer
            executionModes={TEST_MODES}
            onSubmit={onSubmit}
            onStop={() => {}}
            onUploadImage={onUploadImage}
            {...props}
            {...next}
          />
        </LocaleProvider>,
      ),
  }
}

describe("Composer image attachments", () => {
  it("pastes a screenshot from clipboard, previews it, and submits an image-only message", async () => {
    const onSubmit = vi.fn()
    const { editor, onUploadImage } = renderComposer({ onSubmit })
    const png = makePng("clipboard.png")

    await userEvent.click(editor)
    fireEvent.paste(editor, {
      clipboardData: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => png }],
        files: [png],
        getData: () => "",
      },
    })

    await waitFor(() => expect(onUploadImage).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole("button", { name: "移除图片 clipboard.png" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "发送" }).getAttribute("aria-disabled")).toBeNull()

    // 空文本纯图消息可以直接按 Enter 提交。
    await userEvent.keyboard("{Enter}")
    expect(onSubmit).toHaveBeenCalledWith("", {
      effort: null,
      attachmentIds: ["att_1"],
    })
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "移除图片 clipboard.png" })).toBeNull(),
    )
  })

  it("keeps plain text paste working without regression when image upload is enabled", async () => {
    const onSubmit = vi.fn()
    const onUploadImage = vi.fn()
    const { editor } = renderComposer({ onSubmit, onUploadImage })

    await userEvent.click(editor)
    fireEvent.paste(editor, {
      clipboardData: {
        getData: (type: string) =>
          type === "text/plain" ? "line A\nline B" : "<b>line A</b><br>line B",
      },
    })
    await userEvent.keyboard("{Enter}")
    expect(onUploadImage).not.toHaveBeenCalled()
    expect(onSubmit).toHaveBeenCalledWith("line A\nline B", { effort: null })
  })

  it("highlights the composer on drag-over and uploads dropped images", async () => {
    const { container, onUploadImage } = renderComposer()
    const card = container.querySelector(".composer")!
    const file = makePng("drop.png")

    fireEvent.dragEnter(card, { dataTransfer: { types: ["Files"], files: [file] } })
    expect(card.classList.contains("is-drag-over")).toBe(true)
    expect(screen.getByText("松开添加图片")).toBeTruthy()

    fireEvent.drop(card, { dataTransfer: { types: ["Files"], files: [file] } })
    expect(card.classList.contains("is-drag-over")).toBe(false)
    await waitFor(() => expect(onUploadImage).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole("button", { name: "移除图片 drop.png" })).toBeTruthy()
  })

  it("adds multiple images via the + menu, enforces the 6-image limit, and preserves existing input", async () => {
    const user = userEvent.setup()
    const { editor, onUploadImage } = renderComposer()
    await user.type(editor, "保留这段文字")

    // 打开 + 菜单验证顶部的「添加图片」条目存在。
    await user.click(screen.getByRole("button", { name: "添加" }))
    const addImageItem = await screen.findByRole("menuitem", { name: /添加图片/ })
    expect(addImageItem).toBeTruthy()

    const fileInput = screen.getByTestId("composer-image-input") as HTMLInputElement
    const sevenFiles = Array.from({ length: 7 }, (_, i) => makePng(`img-${i + 1}.png`))
    fireEvent.change(fileInput, { target: { files: sevenFiles } })

    await waitFor(() => expect(onUploadImage).toHaveBeenCalledTimes(6))
    expect(screen.getByRole("alert").textContent).toContain("最多添加 6 张图片")
    expect(editor.textContent).toBe("保留这段文字")

    // 达到 6 张上限时，+ 菜单中的「添加图片」条目禁用。
    await user.click(screen.getByRole("button", { name: "添加" }))
    const disabledItem = await screen.findByRole("menuitem", { name: /添加图片/ })
    expect(disabledItem.getAttribute("aria-disabled")).toBe("true")
  })

  it("validates unsupported formats and >10 MiB files without clearing existing attachments", async () => {
    const { onUploadImage } = renderComposer()
    const fileInput = screen.getByTestId("composer-image-input") as HTMLInputElement

    // 先上传 1 张有效图片。
    fireEvent.change(fileInput, { target: { files: [makePng("ok.png")] } })
    await waitFor(() => expect(onUploadImage).toHaveBeenCalledTimes(1))

    // 再添加一张 SVG 和一张超大文件，原有图片不受影响。
    const svg = new File(["<svg></svg>"], "icon.svg", { type: "image/svg+xml" })
    fireEvent.change(fileInput, { target: { files: [svg] } })
    expect(screen.getByRole("alert").textContent).toContain("仅支持 PNG、JPEG、WebP 和 GIF")
    expect(screen.getByRole("button", { name: "移除图片 ok.png" })).toBeTruthy()

    const huge = new File([new Uint8Array(10)], "huge.png", { type: "image/png" })
    Object.defineProperty(huge, "size", { value: 11 * 1024 * 1024 })
    fireEvent.change(fileInput, { target: { files: [huge] } })
    expect(screen.getByRole("alert").textContent).toContain("超过 10 MiB")
    expect(onUploadImage).toHaveBeenCalledTimes(1)
  })

  it("disables submit while uploading and enables it once upload resolves", async () => {
    let resolveUpload!: (ref: ImageAttachmentRef) => void
    const onUploadImage = vi.fn(
      () =>
        new Promise<ImageAttachmentRef>((resolve) => {
          resolveUpload = resolve
        }),
    )
    const onSubmit = vi.fn()
    renderComposer({ onUploadImage, onSubmit })
    const fileInput = screen.getByTestId("composer-image-input") as HTMLInputElement

    fireEvent.change(fileInput, { target: { files: [makePng("slow.png")] } })
    await screen.findByRole("status", { name: "正在上传" })
    await waitFor(() => expect(onUploadImage).toHaveBeenCalledTimes(1))
    expect(screen.getByRole("button", { name: "发送" }).getAttribute("aria-disabled")).toBe("true")

    await act(async () => {
      resolveUpload(makeRef("att_slow", "slow.png"))
    })
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "发送" }).getAttribute("aria-disabled")).toBeNull(),
    )
  })

  it("shows fallback notice when supportsImages is false and images exist", async () => {
    const { rerenderWith } = renderComposer({ supportsImages: false })
    expect(screen.queryByText("当前 Agent 不支持直接看图，将以文件路径传递")).toBeNull()

    const fileInput = screen.getByTestId("composer-image-input") as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [makePng("diagram.png")] } })
    expect(await screen.findByText("当前 Agent 不支持直接看图，将以文件路径传递")).toBeTruthy()

    rerenderWith({ supportsImages: true })
    expect(screen.queryByText("当前 Agent 不支持直接看图，将以文件路径传递")).toBeNull()
  })

  it("removes a thumbnail and supports retrying a failed upload", async () => {
    const user = userEvent.setup()
    let calls = 0
    const onUploadImage = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error("network timeout")
      return makeRef("att_retry", "fail.png")
    })
    renderComposer({ onUploadImage })
    const fileInput = screen.getByTestId("composer-image-input") as HTMLInputElement

    fireEvent.change(fileInput, { target: { files: [makePng("fail.png")] } })
    expect(await screen.findByRole("alert")).toBeTruthy()
    const retryBtn = await screen.findByRole("button", { name: "重试上传 fail.png" })

    await user.click(retryBtn)
    await waitFor(() => expect(onUploadImage).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "重试上传 fail.png" })).toBeNull(),
    )

    await user.click(screen.getByRole("button", { name: "移除图片 fail.png" }))
    expect(screen.queryByRole("button", { name: "移除图片 fail.png" })).toBeNull()
  })

  it("isolates draft images per thread and moves them on draft materialization", async () => {
    const view = renderComposer({ draftKey: "new-thread" })
    const fileInput = screen.getByTestId("composer-image-input") as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [makePng("draft.png")] } })
    expect(await screen.findByRole("button", { name: "移除图片 draft.png" })).toBeTruthy()

    // 切到另一会话后看不到新会话草稿的图片。
    view.rerenderWith({ draftKey: "thread-b" })
    expect(screen.queryByRole("button", { name: "移除图片 draft.png" })).toBeNull()

    // 切回后图片仍在；搬到新会话 t1 后出现在 t1。
    view.rerenderWith({ draftKey: "new-thread" })
    expect(screen.getByRole("button", { name: "移除图片 draft.png" })).toBeTruthy()
    act(() => moveComposerDraft("new-thread", "t1"))
    view.rerenderWith({ draftKey: "t1" })
    expect(screen.getByRole("button", { name: "移除图片 draft.png" })).toBeTruthy()

    // 撤回待发消息时，图片和文字一并还原到草稿。
    const readImage = vi.fn(async () => "data:image/png;base64,ZmFrZQ==")
    view.rerenderWith({ draftKey: "thread-c", readImage })
    act(() => appendComposerText("thread-c", "撤回文字", [makeRef("att_q1", "queued.png")]))
    expect(await screen.findByRole("button", { name: "移除图片 queued.png" })).toBeTruthy()
    await waitFor(() => expect(readImage).toHaveBeenCalledWith("att_q1", "thumb"))
  })
})
