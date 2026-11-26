import {
  DEFAULT_RUNTIME_MODE,
  MAX_MESSAGE_ATTACHMENTS,
  type AgentExecutionModes,
} from "@pigcode/contracts"
import { instancePermissionOptions } from "./permission-options"
import { composerCommands } from "./composer-commands"
// 负责会话输入区：TipTap 正文（@ 文件、/ 命令）、图片附件、agent/模型/思考深度/速度/权限选择，以及发送/停止。
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react"
import { useMemo, useRef, useState, type ReactNode } from "react"
import { useLocale } from "@pigcode/ui-primitives"
import { ComposerAttachMenu, ComposerSubmit } from "./composer-actions"
import {
  ComposerAttachmentStrip,
  extractClipboardImageFiles,
  useComposerAttachments,
  type ComposerImagePeeker,
  type ComposerImageReader,
  type ComposerImageUploader,
  type ComposerPreviewImage,
} from "./composer-attachments"
import { ComposerDropZone } from "./composer-drop-zone"
import {
  handleComposerKeyDown,
  insertComposerTrigger,
  useComposerEditorSync,
  type ComposerHistoryState,
} from "./composer-editor-sync"
import { formContent, readComposerDraft, type ComposerForm } from "./composer-form"
import {
  type ComposerAgent,
  type ComposerModelCatalog,
  type ComposerModelChoice,
  type ComposerRunOptions,
  type PermissionMode,
  type ReasoningEffort,
} from "./composer-options"
import { rememberSent, saveDraft } from "./composer-memory"
import {
  composerExtensions,
  editorText,
  firstPerLabel,
  pastePlainText,
  type ComposerCommand,
} from "./composer-editor"
import { useAgentCommandSource, type AgentCommandLoader } from "./agent-commands"
import { ContextMeter, type ContextUsage } from "./context-meter"
import { ComposerModelControls } from "./composer-model-controls"
import { useRunPreferences } from "./model-preferences"
import { SuggestionPanel } from "./suggestion-panel"
import { SuggestionStore } from "./suggestion-store"
import { ComposerContextChips, useComposerContexts, withContexts } from "./composer-context"
import { useWrapped } from "./composer-layout"
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
  const historyRef = useRef<ComposerHistoryState | null>(null)
  const focusedKeyRef = useRef(focusKey)

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
      handleKeyDown: (_view, event) =>
        handleComposerKeyDown({
          editor: editorRef.current,
          event,
          store,
          historyRef,
          isForm: Boolean(latest.current.form),
          permissionMode: latest.current.permissionMode,
          availableModes: latest.current.availableModes,
          onPermissionMode: latest.current.onPermissionMode,
          onTogglePicker: () => setPickerOpen((value) => !value),
          onSend: () => sendRef.current(),
        }),
    },
    onUpdate: ({ editor: updated }) => {
      if (historyRef.current && editorText(updated) !== historyRef.current.text)
        historyRef.current = null
      latest.current.form?.onChange(readComposerDraft(updated))
    },
  })
  editorRef.current = editor

  useComposerEditorSync({
    editor,
    editorRef,
    draftKey,
    draftKeyRef,
    historyRef,
    disabled,
    autoFocus,
    focusKey,
    focusedKeyRef,
    acceptsExternalContext,
  })

  const typed =
    useEditorState({
      editor,
      selector: ({ editor: current }) => Boolean(current && !current.isEmpty),
    }) ?? false
  const editorEmpty = !typed && attached.contexts.length === 0
  const hasContent =
    typed || attached.contexts.length > 0 || imageAttachments.readyAttachments.length > 0
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

  const card = (
    <ComposerDropZone
      tall={tall}
      expanded={expanded}
      meter={Boolean(contextUsage)}
      imageUploadEnabled={imageUploadEnabled}
      disabled={disabled}
      fileInputRef={fileInputRef}
      onAddFiles={imageAttachments.addFiles}
    >
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
        onTrigger={(char) => insertComposerTrigger(editor, char)}
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
    </ComposerDropZone>
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
