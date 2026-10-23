/** 右侧面板文案：把 locale key 映射成各 surface 与布局按钮的 labels。 */
import type { MessageKey } from "@pigcode/ui-primitives"
import type {
  BrowserViewLabels,
  FileExplorerLabels,
  FileViewerLabels,
  PanelLayoutLabels,
  PrPanelLabels,
  RightPanelLabels,
  SurfaceKind,
} from "@pigcode/ui-workbench"

/** useLocale() 暴露的 t 函数签名。 */
export type Translate = (key: MessageKey) => string

/** surface 种类名称。 */
export function surfaceLabels(t: Translate): Record<SurfaceKind, string> {
  return {
    browser: t("workbench.browser"),
    terminal: t("workbench.terminal"),
    files: t("workbench.files"),
    diff: t("workbench.diff"),
    pr: t("workbench.pr"),
    checkpoint: t("workbench.checkpoint"),
  }
}

/** 右侧面板框架文案。 */
export function rightPanelLabels(t: Translate): RightPanelLabels {
  return {
    panel: t("panel.label"),
    tabs: t("panel.tabs"),
    launcher: t("panel.launcher"),
    add: t("panel.add"),
    close: t("panel.close"),
    plugins: t("panel.plugins"),
    surfaces: surfaceLabels(t),
  }
}

/** 新标签的标题；终端与浏览器按序号区分。 */
export function surfaceTitle(t: Translate, kind: SurfaceKind, index: number): string {
  const name = surfaceLabels(t)[kind]
  if (kind === "terminal") return `${name} ${index}`
  if (kind === "browser" && index > 1) return `${name} ${index}`
  return name
}

/** 布局按钮文案。 */
export function layoutLabels(t: Translate): PanelLayoutLabels {
  return {
    maximize: t("panel.maximize"),
    restore: t("panel.restore"),
    terminal: t("panel.toggleTerminal"),
    right: t("panel.toggleRight"),
  }
}

/** 浏览器文案。 */
export function browserLabels(t: Translate): BrowserViewLabels {
  return {
    address: t("browser.address"),
    back: t("browser.back"),
    forward: t("browser.forward"),
    reload: t("browser.reload"),
    external: t("browser.external"),
    empty: t("browser.empty"),
    emptyHint: t("browser.emptyHint"),
    invalid: t("preview.invalid"),
    bridgeMissing: t("preview.bridgeMissing"),
    agent: t("browser.agent"),
    actions: {
      open: t("browser.action.open"),
      navigate: t("browser.action.navigate"),
      back: t("browser.action.back"),
      forward: t("browser.action.forward"),
      reload: t("browser.action.reload"),
      snapshot: t("browser.action.snapshot"),
      click: t("browser.action.click"),
      type: t("browser.action.type"),
      press: t("browser.action.press"),
      scroll: t("browser.action.scroll"),
      wait: t("browser.action.wait"),
      evaluate: t("browser.action.evaluate"),
      screenshot: t("browser.action.screenshot"),
    },
  }
}

/** PR 面板文案。 */
export function prPanelLabels(t: Translate): PrPanelLabels {
  return {
    empty: t("pr.empty"),
    loading: t("pr.loading"),
    title: t("pr.title"),
    titlePlaceholder: t("pr.titlePlaceholder"),
    body: t("pr.body"),
    bodyPlaceholder: t("pr.bodyPlaceholder"),
    base: t("pr.base"),
    basePlaceholder: t("pr.basePlaceholder"),
    create: t("pr.create"),
    creating: t("pr.creating"),
  }
}

/** 文件资源管理器文案。 */
export function explorerLabels(t: Translate): FileExplorerLabels {
  return {
    tree: t("files.tree"),
    search: t("files.search"),
    clearSearch: t("files.clearSearch"),
    refresh: t("files.refresh"),
    collapseAll: t("files.collapseAll"),
    empty: t("files.empty"),
    loading: t("files.loading"),
    noMatches: t("files.noMatches"),
    searchTruncated: t("files.searchTruncated"),
    loadFailed: t("files.loadFailed"),
  }
}

/** 文件标签文案。 */
export function viewerLabels(t: Translate): FileViewerLabels {
  return {
    loading: t("files.viewer.loading"),
    binary: t("files.viewer.binary"),
    truncated: t("files.viewer.truncated"),
    imageTooLarge: t("files.viewer.imageTooLarge"),
    save: t("files.viewer.save"),
    saving: t("files.viewer.saving"),
    unsaved: t("files.viewer.unsaved"),
    conflict: t("files.viewer.conflict"),
    reload: t("files.viewer.reload"),
    overwrite: t("files.viewer.overwrite"),
    showExplorer: t("files.viewer.showExplorer"),
    hideExplorer: t("files.viewer.hideExplorer"),
    more: t("files.viewer.more"),
    editor: t("files.viewer.editor"),
    breadcrumbs: t("files.viewer.breadcrumbs"),
  }
}
