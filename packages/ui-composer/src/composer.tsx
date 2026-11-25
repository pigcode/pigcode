import {
  DEFAULT_RUNTIME_MODE,
  MAX_MESSAGE_ATTACHMENTS,
  type AgentExecutionModes,
} from "@pigcode/contracts"
import { instancePermissionOptions } from "./permission-options"
import { composerCommands } from "./composer-commands"
// 负责会话输入区：TipTap 正文（@ 文件、/ 命令）、图片附件、agent/模型/思考深度/速度/权限选择，以及发送/停止。
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react"
import { Image as ImageIcon } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent, type ReactNode } from "react"
import { useLocale } from "@pigcode/ui-primitives"
import { ComposerAttachMenu, ComposerSubmit } from "./composer-actions"
import {
  COMPOSER_IMAGE_ACCEPT,
  ComposerAttachmentStrip,
  extractClipboardImageFiles,
  extractDroppedFiles,
  hasDraggedFiles,
  useComposerAttachments,
  type ComposerImagePeeker,
  type ComposerImageReader,
  type ComposerImageUploader,
  type ComposerPreviewImage,
} from "./composer-attachments"
import { formContent, readComposerDraft, type ComposerForm } from "./composer-form"
import {
  getComposerKeyAction,
  nextPermissionMode,
  type ComposerAgent,
  type ComposerModelCatalog,
  type ComposerModelChoice,
  type ComposerRunOptions,
  type PermissionMode,
  type ReasoningEffort,
} from "./composer-options"
import {
  COMPOSER_PREFILL_EVENT,
  COMPOSER_TAKE_EVENT,
  loadDraft,
  prefillKeyOf,
  rememberSent,
  saveDraft,
  sentAt,
  takeComposerFocus,
} from "./composer-memory"
import {
  composerExtensions,
  editorText,
  firstPerLabel,
  pastePlainText,
  setPlainText,
  type ComposerCommand,
} from "./composer-editor"
import { useAgentCommandSource, type AgentCommandLoader } from "./agent-commands"
import { ContextMeter, type ContextUsage } from "./context-meter"
import { ComposerModelControls } from "./composer-model-controls"
import { useRunPreferences } from "./model-preferences"
import { SuggestionPanel } from "./suggestion-panel"
import { SuggestionStore } from "./suggestion-store"
import { COMPOSER_MENTION_EVENT, mentionOf } from "./composer-mention"
import { ComposerContextChips, useComposerContexts, withContexts } from "./composer-context"
import { composerClass, useWrapped } from "./composer-layout"
import {
  editorReferences,
  type ComposerReference,
  type ComposerThreadOption,
} from "./composer-threads"

/** 发送时附带的选项；思考深度、快速模式与 Ultracode 来自当前模型与用户偏好。两个开关只在开着时出现。 */
export interface ComposerSubmitOptions {
  effort: ReasoningEffort | null
  fast?: true
  ultracode?: true
  /** @ 引用的会话；没有引用时不出现。 */
  references?: ComposerReference[]
  /** 随消息发送的图片附件 id；没有附件时不出现。 */
  attachmentIds?: string[]
  /** 表单保存时保留编辑器文档，供重新编辑。 */
  document?: string
}

/** 会话输入区 props；agent、模型、权限都由调用方控制，思考深度与收藏保存在本机偏好里。 */
export interface ComposerProps {
  /** 提交纯文本；空内容不会回调。 */
  onSubmit: (text: string, options: ComposerSubmitOptions) => void
  /** 运行中点击停止按钮。 */
  onStop: () => void
  /** 当前会话正在运行。 */
  running?: boolean
  allowQueue?: boolean
  /** 禁用输入与发送。 */
  disabled?: boolean
  /** 首页使用更高的输入区。 */
  tall?: boolean
  /** 菜单展开方向。 */
  menuSide?: "top" | "bottom"
  /** 覆盖默认的 locale 占位文案。 */
  placeholder?: string
  /** 可选的 Agent 实例与当前选择；agents 为空时不显示模型胶囊。 */
  agents?: readonly ComposerAgent[]
  /** 当前选中的实例 id；默认实例等于 agent id。 */
  agentId?: string | null
  modelId?: string | null
  /** 各实例的模型目录；选择器展开到某个实例时调用 onLoadModels 懒加载。 */
  catalog?: ComposerModelCatalog
  onLoadModels?: (instanceId: string) => void
  onSelectModel?: (choice: ComposerModelChoice) => void
  permissionMode?: PermissionMode
  onPermissionMode?: (mode: PermissionMode) => void
  executionModes?: AgentExecutionModes | null
  planMode?: boolean
  onPlanMode?: (value: boolean) => void
  /** agent 不支持中断时隐藏停止按钮。 */
  canInterrupt?: boolean
  /** 会话当前的上下文占用；没有数据时不显示圆环。 */
  contextUsage?: ContextUsage | null
  /** 是否启用智能标点；默认开启。 */
  smartPunctuation?: boolean
  /** 空会话首次出现时自动聚焦输入区。 */
  autoFocus?: boolean
  /** 每次变化（不是初值）都把光标放回输入区末尾，例如在新会话草稿里再按一次新会话。 */
  focusKey?: number | undefined
  /** 输入框卡片上方的一条，和卡片连成一体，例如新会话草稿里的项目选择。 */
  header?: ReactNode
  /** 输入框卡片下方的工作区控件，与卡片共用外框。 */
  footer?: ReactNode
  /** 表单中提交后保留草稿，Enter 换行，Mod+Enter 提交。 */
  form?: ComposerForm
  /** 指定时让调用方保存这次运行的模型选项。 */
  runOptions?: ComposerRunOptions | undefined
  /** 草稿归属（通常是线程 id）；切换后保存旧草稿、恢复新草稿。 */
  draftKey?: string | null
  /** @ 引用时可选的项目文件（相对路径）。 */
  files?: () => Promise<readonly string[]>
  /** @ 引用时可选的会话（#81），按最近活动排好、不含当前会话。 */
  threads?: readonly ComposerThreadOption[]
  /** / 命令；内置的切换模型与权限之外的命令由调用方提供。 */
  commands?: readonly ComposerCommand[]
  /** 读一个 Agent 实例的 / 命令与 skill；输入框获得焦点时预取当前实例的，调用方负责缓存。 */
  loadAgentCommands?: AgentCommandLoader | undefined
  /** 上传图片附件；提供时开启图片粘贴、拖放与 `+` 菜单添加图片。 */
  onUploadImage?: ComposerImageUploader | undefined
  /** 按需读取已上传图片的缩略图/原图（用于撤回恢复的草稿图片）。 */
  readImage?: ComposerImageReader | undefined
  /** 同步读取内存缓存中的缩略图 URL。 */
  peekImage?: ComposerImagePeeker | undefined
  /** 当前 Agent 是否支持直接看图；明确为 false 且有图片时展示降级提示。 */
  supportsImages?: boolean | undefined
  /** 点击草稿缩略图打开灯箱核对；不提供时使用内置轻量预览。 */
  onPreviewImages?: ((images: readonly ComposerPreviewImage[], index: number) => void) | undefined
}

/** 绘制 TipTap 输入区并保证空内容不可提交。 */
export function Composer({
  onSubmit,
  onStop,
  running = false,
  allowQueue = false,
  disabled = false,
  tall = false,
  menuSide = "top",
  placeholder,
  agents = [],
  agentId = null,
  modelId = null,
  catalog = {},
  onLoadModels,
  onSelectModel,
  permissionMode = DEFAULT_RUNTIME_MODE,
  onPermissionMode,
  executionModes: explicitModes,
  planMode = false,
  onPlanMode,
  canInterrupt = true,
  contextUsage = null,
  smartPunctuation = true,
  autoFocus = false,
  focusKey,
  header,
  footer,
  form,
  runOptions,
  draftKey = null,
  files,
  threads,
  commands = [],
  loadAgentCommands,
  onUploadImage,
  readImage,
  peekImage,
  supportsImages,
  onPreviewImages,
}: ComposerProps) {
  const { t, locale } = useLocale()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const dragDepthRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [initialContent] = useState(() => (form ? formContent(form.draft) : null))
  const store = useMemo(() => new SuggestionStore(), [])
  const { effort, fast, ultracode } = useRunPreferences(
    agentId,
    catalog,
    modelId,
    runOptions?.value,
  )
  const acceptsExternalContext = form === undefined
  const executionModes =
    explicitModes ?? agents.find((agent) => agent.id === agentId)?.executionModes
  const { availableModes, invalidPermission } = instancePermissionOptions(
    executionModes,
    permissionMode,
  )

  const builtinCommands = composerCommands({
    locale,
    t,
    hasAgents: agents.length > 0,
    modes: availableModes,
    openModels: () => setPickerOpen(true),
    onPermissionMode,
    planMode,
    onPlanMode: executionModes?.plan || planMode ? onPlanMode : undefined,
  })

  // 同一个 `/` 名字只留第一条：输入框自己的命令在前，外面传进来的重名命令不显示。
  const allCommands = firstPerLabel([...builtinCommands, ...commands])
  const agentSource = useAgentCommandSource(agentId, loadAgentCommands)

  // 编辑器只创建一次；回调与配置通过 ref 读取最新值。
  const live = {
    onSubmit,
    disabled: disabled || invalidPermission,
    submitBlocked: (running && !allowQueue) || Boolean(form?.submitDisabled),
    imageUploadEnabled: acceptsExternalContext && Boolean(onUploadImage),
    form,
    effort,
    fast,
    ultracode,
    permissionMode,
    availableModes,
    onPermissionMode,
    placeholder: placeholder ?? t("composer.placeholder"),
    inputLabel: form?.inputLabel ?? t("composer.input"),
    smartPunctuation,
    files,
    threads,
    commands: allCommands,
    agentCommands: agentSource,
  }
  const latest = useRef(live)
  latest.current = live
  const editorRef = useRef<Editor | null>(null)
  const draftKeyRef = useRef<string | null>(draftKey)
  const attached = useComposerContexts(
    disabled || !acceptsExternalContext,
    () => editorRef.current?.commands.focus(),
    draftKey,
  )
  const contextsRef = useRef(attached)
  contextsRef.current = attached
  const imageUploadEnabled = acceptsExternalContext && Boolean(onUploadImage)
  const imageAttachments = useComposerAttachments({
    draftKey,
    disabled: disabled || !imageUploadEnabled,
    onUploadImage: imageUploadEnabled ? onUploadImage : undefined,
  })
  const attachmentsRef = useRef(imageAttachments)
  attachmentsRef.current = imageAttachments
  /** 正在翻历史时记录位置；内容被改动后退出翻找。 */
  const historyRef = useRef<{ offset: number; text: string } | null>(null)

  function send(): void {
    const editor = editorRef.current
    const current = latest.current
    if (!editor || current.disabled || current.submitBlocked) return
    const text = editorText(editor)
    const { contexts, clear } = contextsRef.current
    const {
      readyAttachments,
      uploading,
      hasError,
      clear: clearAttachments,
    } = attachmentsRef.current
    if (uploading || hasError) return
    if (!text && contexts.length === 0 && readyAttachments.length === 0) return
    const references = editorReferences(editor)
    const attachmentIds = readyAttachments.map((item) => item.id)
    const key = draftKeyRef.current
    if (key) saveDraft(key, editor.isEmpty ? null : editor.getJSON())
    current.onSubmit(withContexts(text, contexts), {
      effort: current.effort,
      ...(current.fast ? { fast: true as const } : {}),
      ...(current.ultracode ? { ultracode: true as const } : {}),
      ...(references.length > 0 ? { references } : {}),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      ...(current.form ? { document: JSON.stringify(editor.getJSON()) } : {}),
    })
    if (current.form) return
    if (text) rememberSent(text)
    historyRef.current = null
    editor.commands.clearContent(true)
    clear()
    clearAttachments()
    if (draftKeyRef.current) saveDraft(draftKeyRef.current, null)
  }
  const sendRef = useRef(send)
  sendRef.current = send

  /** ↑/↓ 在空输入框里翻找发送过的消息；返回是否处理了按键。 */
  function browseHistory(editor: Editor, direction: 1 | -1): boolean {
    const navigating = historyRef.current
    if (!navigating && (direction < 0 || !editor.isEmpty)) return false
    const offset = navigating ? navigating.offset + direction : 0
    if (offset < 0) {
      historyRef.current = null
      editor.commands.clearContent(true)
      return true
    }
    const text = sentAt(offset)
    if (text === null) return Boolean(navigating)
    historyRef.current = { offset, text }
    setPlainText(editor, text)
    return true
  }

  const editor = useEditor({
    immediatelyRender: true,
    ...(initialContent ? { content: initialContent } : {}),
    onFocus: () => void latest.current.agentCommands?.(),
    extensions: composerExtensions(
      {
        placeholder: () => latest.current.placeholder,
        smartPunctuation: () => latest.current.smartPunctuation,
        files: () => latest.current.files,
        threads: () => latest.current.threads,
        commands: () => latest.current.commands,
        agentCommands: () => latest.current.agentCommands,
      },
      store,
    ),
    editorProps: {
      attributes: () => ({
        class: "tiptap",
        "aria-label": latest.current.inputLabel,
        ...(latest.current.form ? { role: "textbox", "aria-multiline": "true" } : {}),
      }),
      handlePaste: (view, event) => {
        if (!editorRef.current) return false
        if (latest.current.imageUploadEnabled && !latest.current.disabled) {
          const files = extractClipboardImageFiles(event.clipboardData)
          if (files.length > 0) {
            event.preventDefault()
            void attachmentsRef.current.addFiles(files)
            return true
          }
        }
        return pastePlainText(editorRef.current, view, event)
      },
      handleKeyDown: (_view, event) => {
        const current = editorRef.current
        if (!current || event.isComposing) return false
        const suggesting = store.getSnapshot()
        // 建议列表打开时，方向键、回车、Tab、Esc 交给建议列表。
        if (suggesting.active && ["ArrowUp", "ArrowDown", "Tab", "Escape"].includes(event.key))
          return false
        if (suggesting.active && event.key === "Enter" && suggesting.items.length > 0) return false
        if ((event.metaKey || event.ctrlKey) && event.key === "/") {
          event.preventDefault()
          setPickerOpen((value) => !value)
          return true
        }
        if (event.key === "Tab" && event.shiftKey && latest.current.onPermissionMode) {
          event.preventDefault()
          latest.current.onPermissionMode(
            nextPermissionMode(latest.current.permissionMode, latest.current.availableModes),
          )
          return true
        }
        const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey
        if (plain && event.key === "ArrowUp" && browseHistory(current, 1)) return true
        if (plain && event.key === "ArrowDown" && browseHistory(current, -1)) return true
        if (latest.current.form && event.key === "Enter" && !(event.metaKey || event.ctrlKey))
          return false
        const action = getComposerKeyAction(event.key, event.shiftKey)
        if (action === "ignore" || action === "newline") return false
        event.preventDefault()
        sendRef.current()
        return true
      },
    },
    onUpdate: ({ editor: updated }) => {
      if (historyRef.current && editorText(updated) !== historyRef.current.text)
        historyRef.current = null
      latest.current.form?.onChange(readComposerDraft(updated))
    },
  })
  editorRef.current = editor

  useEffect(() => {
    editor?.setEditable(!disabled, false)
  }, [editor, disabled])

  useEffect(() => {
    if (autoFocus && !disabled) editor?.commands.focus()
  }, [autoFocus, disabled, editor])

  const focusedKey = useRef(focusKey)
  useEffect(() => {
    if (focusKey === focusedKey.current) return
    focusedKey.current = focusKey
    if (!disabled) editor?.commands.focus("end")
  }, [focusKey, disabled, editor])

  // 预填的正是这个输入框（新会话的建议、「创建插件」）：立刻换上预填的内容。
  // 要把草稿搬走（新会话草稿建成了会话）：先存下正在写的内容，再清空自己。
  useEffect(() => {
    if (!editor) return undefined
    const onMemory = (event: Event): void => {
      const key = prefillKeyOf(event)
      if (!key || key !== draftKeyRef.current || editor.isDestroyed) return
      if (event.type === COMPOSER_TAKE_EVENT) {
        saveDraft(key, editor.isEmpty ? null : editor.getJSON())
        editor.commands.clearContent(false)
        return
      }
      historyRef.current = null
      editor.commands.setContent(loadDraft(key) ?? "", { emitUpdate: false })
      takeComposerFocus(key)
      editor.commands.focus("end")
    }
    const types = [COMPOSER_PREFILL_EVENT, COMPOSER_TAKE_EVENT]
    for (const type of types) window.addEventListener(type, onMemory)
    return () => types.forEach((type) => window.removeEventListener(type, onMemory))
  }, [editor])

  // 切换会话时保存旧草稿、恢复新草稿；卸载时也保存一次。
  useEffect(() => {
    if (!editor) return
    const previous = draftKeyRef.current
    if (previous === draftKey) {
      const initial = draftKey ? loadDraft(draftKey) : null
      if (initial && editor.isEmpty) editor.commands.setContent(initial, { emitUpdate: false })
      if (draftKey && takeComposerFocus(draftKey)) editor.commands.focus("end")
      return
    }
    if (previous) saveDraft(previous, editor.isEmpty ? null : editor.getJSON())
    draftKeyRef.current = draftKey
    historyRef.current = null
    const next = draftKey ? loadDraft(draftKey) : null
    editor.commands.setContent(next ?? "", { emitUpdate: false })
    // 从外面预填的会话（「创建插件」）：光标停在预填文字的末尾，接着写。
    if (draftKey && takeComposerFocus(draftKey)) editor.commands.focus("end")
  }, [draftKey, editor])
  useEffect(
    () => () => {
      const key = draftKeyRef.current
      const current = editorRef.current
      if (key && current && !current.isDestroyed)
        saveDraft(key, current.isEmpty ? null : current.getJSON())
    },
    [],
  )

  // 文件树的「添加到对话」、侧栏的「在输入框里引用」：在光标处插入引用，与输入 @ 选中的效果相同。
  useEffect(() => {
    if (!editor || !acceptsExternalContext) return undefined
    const onMention = (event: Event): void => {
      const mention = mentionOf(event)
      if (!mention || disabled) return
      editor
        .chain()
        .focus()
        .insertContent([
          { type: "mention", attrs: mention },
          { type: "text", text: " " },
        ])
        .run()
    }
    window.addEventListener(COMPOSER_MENTION_EVENT, onMention)
    return () => window.removeEventListener(COMPOSER_MENTION_EVENT, onMention)
  }, [editor, disabled, acceptsExternalContext])

  const typed =
    useEditorState({
      editor,
      selector: ({ editor: current }) => Boolean(current && !current.isEmpty),
    }) ?? false
  const editorEmpty = !typed && attached.contexts.length === 0
  const hasContent = typed || attached.contexts.length > 0 || imageAttachments.readyAttachments.length > 0
  const submitDisabled =
    !hasContent ||
    imageAttachments.uploading ||
    imageAttachments.hasError ||
    disabled ||
    invalidPermission ||
    Boolean(form?.submitDisabled)
  const wrapped = useWrapped(editor, !tall)
  const expanded =
    tall ||
    wrapped ||
    attached.contexts.length > 0 ||
    imageAttachments.items.length > 0 ||
    Boolean(imageAttachments.error)

  /** 在光标处插入触发字符，打开对应的建议列表。 */
  function insertTrigger(char: "@" | "/"): void {
    if (!editor) return
    const before = editor.state.selection.$from.parent.textContent.slice(
      0,
      editor.state.selection.$from.parentOffset,
    )
    const prefix = char === "@" && before && !/\s$/.test(before) ? " " : ""
    editor.chain().focus().insertContent(`${prefix}${char}`).run()
  }

  function handleCardPaste(event: ReactClipboardEvent<HTMLDivElement>): void {
    if (event.defaultPrevented || !imageUploadEnabled || disabled) return
    if (event.target instanceof Element && event.target.closest(".tiptap")) return
    const files = extractClipboardImageFiles(event.clipboardData)
    if (files.length === 0) return
    event.preventDefault()
    void imageAttachments.addFiles(files)
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>): void {
    if (!imageUploadEnabled || disabled || !hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepthRef.current += 1
    setDragging(true)
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    if (!imageUploadEnabled || disabled || !hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    try {
      event.dataTransfer.dropEffect = "copy"
    } catch {
      // jsdom 等环境里 dataTransfer 可能是只读 mock。
    }
    setDragging(true)
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>): void {
    if (!imageUploadEnabled || !dragging) return
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    ) {
      return
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragging(false)
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    dragDepthRef.current = 0
    setDragging(false)
    if (!imageUploadEnabled || disabled || !hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    const files = extractDroppedFiles(event.dataTransfer)
    if (files.length > 0) void imageAttachments.addFiles(files)
  }

  const card = (
    <div
      className={composerClass({ tall, expanded, meter: Boolean(contextUsage), dragging })}
      onPaste={handleCardPaste}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragging ? (
        <div className="composer-drop-overlay" aria-hidden="true">
          <ImageIcon className="ic" />
          <span>{t("composer.image.dropHint")}</span>
        </div>
      ) : null}
      {imageUploadEnabled ? (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={COMPOSER_IMAGE_ACCEPT}
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
          data-testid="composer-image-input"
          onChange={(event) => {
            const files = event.target.files
            if (files && files.length > 0) void imageAttachments.addFiles(files)
            event.target.value = ""
          }}
        />
      ) : null}
      <SuggestionPanel store={store} />
      <ComposerAttachmentStrip
        items={imageAttachments.items}
        error={imageAttachments.error}
        supportsImages={supportsImages}
        readImage={readImage}
        peekImage={peekImage}
        onRemove={imageAttachments.remove}
        onRetry={imageAttachments.retry}
        onDismissError={imageAttachments.dismissError}
        onPreviewImages={onPreviewImages}
      />
      <ComposerContextChips contexts={attached.contexts} onRemove={attached.remove} />
      <EditorContent editor={editor} className="composer-editor" />
      <ComposerAttachMenu
        empty={editorEmpty}
        disabled={disabled}
        side={menuSide}
        onTrigger={insertTrigger}
        onPickImages={imageUploadEnabled ? () => fileInputRef.current?.click() : undefined}
        imageCount={imageAttachments.items.length}
        maxImages={MAX_MESSAGE_ATTACHMENTS}
      />
      <ComposerModelControls
        agents={agents}
        agentId={agentId}
        modelId={modelId}
        catalog={catalog}
        runOptions={runOptions}
        onLoadModels={onLoadModels}
        onSelectModel={(choice) => onSelectModel?.(choice)}
        selectable={Boolean(onSelectModel)}
        permissionMode={permissionMode}
        permissionModes={availableModes}
        planMode={planMode}
        onPlanMode={executionModes?.plan || planMode ? onPlanMode : undefined}
        onPermissionMode={onPermissionMode}
        running={running}
        side={menuSide}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
      />
      {contextUsage ? <ContextMeter usage={contextUsage} /> : null}
      <ComposerSubmit
        running={running}
        allowQueue={allowQueue}
        canInterrupt={canInterrupt}
        formLabel={form?.submitLabel}
        disabled={submitDisabled}
        onSubmit={() => sendRef.current()}
        onStop={onStop}
      />
    </div>
  )

  return (
    <div className="composer-shell">
      {invalidPermission && (
        <p className="agent-muted" role="status">
          {t("composer.permission.selectSupported")}
        </p>
      )}
      {header || footer ? (
        <div className="composer-frame">
          {header ? <div className="composer-frame-bar composer-head">{header}</div> : null}
          {card}
          {footer ? <div className="composer-frame-bar composer-foot">{footer}</div> : null}
        </div>
      ) : (
        card
      )}
    </div>
  )
}
