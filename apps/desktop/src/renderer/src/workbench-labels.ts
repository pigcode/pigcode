/** 工作台文案：把 locale key 映射成右栏与各面板的 labels。 */
import type { MessageKey } from "@pigcode/ui-primitives"
import type { PrPanelLabels, PreviewPanelLabels, RightPanelTab } from "@pigcode/ui-workbench"

/** useLocale() 暴露的 t 函数签名。 */
export type Translate = (key: MessageKey) => string

/** 右栏 tab 标题。 */
export function tabLabels(t: Translate): Record<RightPanelTab, string> {
  return {
    files: t("workbench.files"),
    diff: t("workbench.diff"),
    terminal: t("workbench.terminal"),
    checkpoint: t("workbench.checkpoint"),
    pr: t("workbench.pr"),
    preview: t("workbench.preview"),
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

/** 预览面板文案；未覆盖的字段回落到组件默认值。 */
export function previewPanelLabels(t: Translate): Partial<PreviewPanelLabels> {
  return {
    url: t("preview.url"),
    open: t("preview.open"),
    opening: t("preview.opening"),
    hint: t("preview.hint"),
    invalid: t("preview.invalid"),
    bridgeMissing: t("preview.bridgeMissing"),
  }
}
