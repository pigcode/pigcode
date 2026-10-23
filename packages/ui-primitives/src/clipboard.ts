/** 写入剪贴板；剪贴板接口不可用时，退回选中隐藏文本框再复制。 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = document.createElement("textarea")
    area.value = text
    area.setAttribute("readonly", "")
    area.style.position = "fixed"
    area.style.opacity = "0"
    document.body.append(area)
    area.select()
    document.execCommand("copy")
    area.remove()
  }
}
