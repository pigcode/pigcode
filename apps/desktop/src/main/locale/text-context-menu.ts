/** 原生文字菜单按桌面语言显示，与系统托盘和其他原生窗口一致。 */
const ZH = {
  undo: "撤销",
  redo: "重做",
  cut: "剪切",
  copy: "复制",
  paste: "粘贴",
  selectAll: "全选",
}
const EN = {
  undo: "Undo",
  redo: "Redo",
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  selectAll: "Select All",
}

export function textContextMenuLabels(locale: string) {
  return locale.toLowerCase().startsWith("zh") ? ZH : EN
}
