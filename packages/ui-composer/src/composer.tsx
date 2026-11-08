// 负责会话输入区：TipTap 正文（@ 文件、/ 命令）、权限、agent/模型/思考深度选择，以及发送/停止。
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react"
import { ArrowUp, AtSign, Plus, Slash, Square } from "lucide-react"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Button, Menu, useLocale } from "@pigcode/ui-primitives"
import {
  getComposerKeyAction,
  nextPermissionMode,
  permissionKeys,
  permissionModes,
  resolveEffort,
  resolveModel,
  type ComposerAgent,
  type ComposerModelCatalog,
  type ComposerModelChoice,
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
import { ModelPicker } from "./model-picker"
import { modelKey, useModelPreferences } from "./model-preferences"
import { PermissionMenu } from "./permission-menu"
import { SuggestionPanel } from "./suggestion-panel"
import { SuggestionStore } from "./suggestion-store"
import { COMPOSER_MENTION_EVENT, mentionPathOf } from "./composer-mention"
import { ComposerContextChips, useComposerContexts, withContexts } from "./composer-context"
import { useWrapped } from "./composer-layout"

/** 发送时附带的选项；思考深度来自当前模型与用户偏好。 */
export interface ComposerSubmitOptions {
  effort: ReasoningEffort | null
}

/** 会话输入区 props；agent、模型、权限都由调用方控制，思考深度与收藏保存在本机偏好里。 */
export interface ComposerProps {
  /** 提交纯文本；空内容不会回调。 */
  onSubmit: (text: string, options: ComposerSubmitOptions) => void
  /** 运行中点击停止按钮。 */
  onStop: () => void
  /** 有 run 进行中时把发送按钮换成停止按钮。 */
  running?: boolean
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
  /** agent 不支持计划模式时隐藏该权限选项。 */
  canPlan?: boolean
  /** agent 不支持中断时隐藏停止按钮。 */
  canInterrupt?: boolean
  /** 是否启用智能标点；默认开启。 */
  smartPunctuation?: boolean
  /** 空会话首次出现时自动聚焦输入区。 */
  autoFocus?: boolean
  /** 每次变化（不是初值）都把光标放回输入区末尾，例如在新会话草稿里再按一次新会话。 */
  focusKey?: number | undefined
  /** 输入框卡片上方的一条，和卡片连成一体，例如新会话草稿里的项目选择。 */
  header?: ReactNode
  /** 草稿归属（通常是线程 id）；切换后保存旧草稿、恢复新草稿。 */
  draftKey?: string | null
  /** @ 引用时可选的项目文件（相对路径）。 */
  files?: () => Promise<readonly string[]>
  /** / 命令；内置的切换模型与权限之外的命令由调用方提供。 */
  commands?: readonly ComposerCommand[]
}

/** 绘制 TipTap 输入区并保证空内容不可提交。 */
export function Composer({
  onSubmit,
  onStop,
  running = false,
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
  permissionMode = "workspace-write",
  onPermissionMode,
  canPlan = true,
  canInterrupt = true,
  smartPunctuation = true,
  autoFocus = false,
  focusKey,
  header,
  draftKey = null,
  files,
  commands = [],
}: ComposerProps) {
  const { t } = useLocale()
  const preferences = useModelPreferences()
  const [pickerOpen, setPickerOpen] = useState(false)
  const store = useMemo(() => new SuggestionStore(), [])
  const currentModel = resolveModel(agentId ? catalog[agentId] : undefined, modelId)
  const effort = resolveEffort(
    currentModel,
    agentId && currentModel ? preferences.efforts[modelKey(agentId, currentModel.id)] : null,
  )
  const availableModes = canPlan ? permissionModes : permissionModes.filter((id) => id !== "plan")

  const builtinCommands: ComposerCommand[] = [
    ...(agents.length > 0
      ? [
          {
            id: "model",
            label: "/model",
            description: t("composer.command.model"),
            keywords: [t("composer.command.model.keyword")],
            run: () => setPickerOpen(true),
          },
        ]
      : []),
    ...(onPermissionMode
      ? availableModes
          .filter((mode) => mode !== "danger-full-access")
          .map((mode) => ({
            id: `permission-${mode}`,
            label: `/${mode === "workspace-write" ? "ask" : mode === "read-only" ? "readonly" : mode}`,
            description: t(permissionKeys[mode].label),
            run: () => onPermissionMode(mode),
          }))
      : []),
  ]

  // 同一个 `/` 名字只留第一条：输入框自己的命令在前，外面传进来的重名命令不显示。
  const allCommands = firstPerLabel([...builtinCommands, ...commands])

  // 编辑器只创建一次；回调与配置通过 ref 读取最新值。
  const latest = useRef({
    onSubmit,
    running,
    disabled,
    effort,
    permissionMode,
    availableModes,
    onPermissionMode,
    placeholder: placeholder ?? t("composer.placeholder"),
    inputLabel: t("composer.input"),
    smartPunctuation,
    files,
    commands: allCommands,
  })
  latest.current = {
    onSubmit,
    running,
    disabled,
    effort,
    permissionMode,
    availableModes,
    onPermissionMode,
    placeholder: placeholder ?? t("composer.placeholder"),
    inputLabel: t("composer.input"),
    smartPunctuation,
    files,
    commands: allCommands,
  }
  const editorRef = useRef<Editor | null>(null)
  const draftKeyRef = useRef<string | null>(draftKey)
  const attached = useComposerContexts(
    Boolean(disabled),
    () => editorRef.current?.commands.focus(),
    draftKey,
  )
  const contextsRef = useRef(attached)
  contextsRef.current = attached
  /** 正在翻历史时记录位置；内容被改动后退出翻找。 */
  const historyRef = useRef<{ offset: number; text: string } | null>(null)

  /** 交出文本后清空输入区，下一条消息从空白开始。 */
  function send(): void {
    const editor = editorRef.current
    const current = latest.current
    if (!editor || current.disabled || current.running) return
    const text = editorText(editor)
    const { contexts, clear } = contextsRef.current
    if (!text && contexts.length === 0) return
    current.onSubmit(withContexts(text, contexts), { effort: current.effort })
    if (text) rememberSent(text)
    historyRef.current = null
    editor.commands.clearContent(true)
    clear()
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
    extensions: composerExtensions(
      {
        placeholder: () => latest.current.placeholder,
        smartPunctuation: () => latest.current.smartPunctuation,
        files: () => latest.current.files,
        commands: () => latest.current.commands,
      },
      store,
    ),
    editorProps: {
      attributes: () => ({ class: "tiptap", "aria-label": latest.current.inputLabel }),
      handlePaste: (view, event) =>
        editorRef.current ? pastePlainText(editorRef.current, view, event) : false,
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
    },
  })
  editorRef.current = editor

  useEffect(() => {
    editor?.setEditable(!disabled)
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

  // 文件树的「添加到对话」：在光标处插入 @文件 引用，与输入 @ 选中的效果相同。
  useEffect(() => {
    if (!editor) return undefined
    const onMention = (event: Event): void => {
      const path = mentionPathOf(event)
      if (!path || disabled) return
      editor
        .chain()
        .focus()
        .insertContent([
          { type: "mention", attrs: { id: path, label: path } },
          { type: "text", text: " " },
        ])
        .run()
    }
    window.addEventListener(COMPOSER_MENTION_EVENT, onMention)
    return () => window.removeEventListener(COMPOSER_MENTION_EVENT, onMention)
  }, [editor, disabled])

  const typed =
    useEditorState({
      editor,
      selector: ({ editor: current }) => Boolean(current && !current.isEmpty),
    }) ?? false
  const empty = !typed && attached.contexts.length === 0
  const wrapped = useWrapped(editor, !tall)
  const expanded = tall || wrapped || attached.contexts.length > 0

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

  const card = (
    <div
      className={["composer", tall ? "is-tall" : "", expanded ? "is-expanded" : "is-compact"]
        .filter(Boolean)
        .join(" ")}
    >
      <SuggestionPanel store={store} />
      <ComposerContextChips contexts={attached.contexts} onRemove={attached.remove} />
      <EditorContent editor={editor} className="composer-editor" />
      <Menu.Root>
        <Menu.Trigger
          className="icon-btn composer-attach"
          type="button"
          aria-label={t("composer.attach")}
          title={t("composer.attach")}
          disabled={disabled}
        >
          <Plus className="ic" aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side={menuSide} align="start" sideOffset={8}>
            <Menu.Popup>
              <Menu.Item onClick={() => insertTrigger("@")}>
                <AtSign className="ic" aria-hidden="true" />
                <span className="grow">{t("composer.attach.file")}</span>
                <span className="menu-meta">@</span>
              </Menu.Item>
              <Menu.Item disabled={!empty} onClick={() => insertTrigger("/")}>
                <Slash className="ic" aria-hidden="true" />
                <span className="grow">{t("composer.attach.command")}</span>
                <span className="menu-meta">/</span>
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <PermissionMenu
        value={permissionMode}
        modes={availableModes}
        onChange={onPermissionMode}
        side={menuSide}
      />
      {agents.length > 0 ? (
        <ModelPicker
          agents={agents}
          agentId={agentId}
          modelId={modelId}
          catalog={catalog}
          onLoadModels={onLoadModels}
          onSelectModel={(choice) => {
            onSelectModel?.(choice)
            editor?.commands.focus()
          }}
          locked={running || !onSelectModel}
          side={menuSide}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
        />
      ) : null}
      {running && canInterrupt ? (
        <Button
          variant="plain"
          className="send is-stop"
          type="button"
          aria-label={t("chat.interrupt")}
          title={t("chat.interrupt")}
          onClick={onStop}
        >
          <Square className="ic" aria-hidden="true" />
        </Button>
      ) : running ? null : (
        <Button
          variant="plain"
          className="send"
          type="button"
          aria-label={t("chat.send")}
          title={t("chat.send")}
          aria-disabled={empty || disabled ? true : undefined}
          onClick={() => sendRef.current()}
        >
          <ArrowUp className="ic" aria-hidden="true" />
        </Button>
      )}
    </div>
  )

  return (
    <div className="composer-shell">
      {header ? (
        <div className="composer-frame">
          <div className="composer-head">{header}</div>
          {card}
        </div>
      ) : (
        card
      )}
    </div>
  )
}
