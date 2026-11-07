/**
 * 选择网页元素加入聊天：往 webview 里临时注入一段脚本，悬停的元素描上边框并显示标签和尺寸，
 * 点击后采集这个元素并退出，按 Esc 取消。采集的内容变成输入框上方的一个附件，发送时以 Markdown 交给 agent。
 * 不读 cookie 和存储，不采集输入框的值，密码框只留类型。
 */
import type { ComposerContext } from "@pigcode/ui-composer"
import type { MessageKey } from "@pigcode/ui-primitives"

/** 页面上选中的元素。 */
export interface PickedElement {
  url: string
  title: string
  tag: string
  selector: string
  name: string | null
  text: string
  html: string
  size: { width: number; height: number }
  style: string
}

/** 高亮用的颜色与字体，取自应用当前的主题 token。 */
interface PickerTheme {
  accent: string
  label: string
  labelText: string
  font: string
}

function themeOf(): PickerTheme {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string) => style.getPropertyValue(name).trim()
  return {
    accent: read("--accent"),
    label: read("--primary"),
    labelText: read("--on-primary"),
    font: read("--font-ui") || "system-ui",
  }
}

/** 页面里执行的选择脚本；结果是 PickedElement 或 null。再次注入会先取消上一次。 */
export function pickerScript(theme: PickerTheme = themeOf()): string {
  return `(() => {
  window.__pigcodePick?.cancel();
  const theme = ${JSON.stringify(theme)};
  return new Promise((resolve) => {
    const doc = document;
    const host = doc.documentElement;
    const box = doc.createElement("div");
    const tag = doc.createElement("div");
    const cursor = doc.createElement("style");
    cursor.textContent = "* { cursor: crosshair !important; }";
    const layer = { position: "fixed", zIndex: "2147483647", pointerEvents: "none", display: "none" };
    Object.assign(box.style, layer, {
      border: "2px solid " + theme.accent,
      background: "color-mix(in oklch, " + theme.accent + " 12%, transparent)",
      borderRadius: "3px",
      transition: "left 60ms, top 60ms, width 60ms, height 60ms",
    });
    Object.assign(tag.style, layer, {
      padding: "2px 6px",
      borderRadius: "4px",
      background: theme.label,
      color: theme.labelText,
      font: "500 11px/16px " + theme.font,
      whiteSpace: "nowrap",
    });
    host.append(box, tag);
    try { host.append(cursor); } catch {}
    const clip = (value, limit) => (value.length > limit ? value.slice(0, limit) + "…" : value);
    const short = (el) => {
      let name = el.tagName.toLowerCase();
      if (el.id) return name + "#" + el.id;
      const classes = [...el.classList].filter((item) => !item.includes(":")).slice(0, 2);
      return classes.length ? name + "." + classes.join(".") : name;
    };
    const path = (el) => {
      const parts = [];
      for (let node = el; node && node.nodeType === 1 && parts.length < 5; node = node.parentElement) {
        if (node === doc.body || node === host) break;
        if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
        let part = node.tagName.toLowerCase();
        const classes = [...node.classList].filter((item) => !item.includes(":")).slice(0, 2);
        if (classes.length) part += "." + classes.map((item) => CSS.escape(item)).join(".");
        const parent = node.parentElement;
        if (parent) {
          const same = [...parent.children].filter((item) => item.tagName === node.tagName);
          if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
        }
        parts.unshift(part);
      }
      return parts.join(" > ");
    };
    const describe = (el) => {
      const rect = el.getBoundingClientRect();
      const copy = el.cloneNode(true);
      const fields = copy.matches?.("input, textarea") ? [copy] : [...copy.querySelectorAll("input, textarea")];
      for (const field of fields) {
        field.removeAttribute("value");
        if (field.tagName === "TEXTAREA") field.textContent = "";
      }
      const computed = getComputedStyle(el);
      return {
        url: location.href,
        title: doc.title,
        tag: el.tagName.toLowerCase(),
        selector: path(el),
        name: el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt") || null,
        text: el.matches("input, textarea") ? "" : clip((el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim(), 300),
        html: clip(copy.outerHTML.replace(/\\s+/g, " "), 1500),
        size: { width: Math.round(rect.width), height: Math.round(rect.height) },
        style: [computed.display, computed.fontSize + " " + computed.fontWeight, computed.color, computed.backgroundColor].join(", "),
      };
    };
    let current = null;
    const show = (el) => {
      current = el;
      const rect = el.getBoundingClientRect();
      Object.assign(box.style, { display: "block", left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px" });
      tag.textContent = short(el) + "  " + Math.round(rect.width) + "×" + Math.round(rect.height);
      const top = rect.top > 26 ? rect.top - 24 : Math.min(innerHeight - 22, rect.bottom + 4);
      Object.assign(tag.style, { display: "block", left: Math.max(4, Math.min(rect.left, innerWidth - 200)) + "px", top: top + "px" });
    };
    const move = (event) => {
      const el = doc.elementFromPoint(event.clientX, event.clientY);
      if (el && el !== box && el !== tag && el !== current) show(el);
    };
    const swallow = (event) => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); };
    const blocked = ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "contextmenu"];
    const finish = (value) => {
      doc.removeEventListener("mousemove", move, true);
      doc.removeEventListener("click", click, true);
      doc.removeEventListener("keydown", key, true);
      for (const type of blocked) doc.removeEventListener(type, swallow, true);
      box.remove(); tag.remove(); cursor.remove();
      delete window.__pigcodePick;
      resolve(value);
    };
    const click = (event) => {
      swallow(event);
      const el = current || doc.elementFromPoint(event.clientX, event.clientY);
      finish(el ? describe(el) : null);
    };
    const key = (event) => { if (event.key === "Escape") { swallow(event); finish(null); } };
    window.__pigcodePick = { cancel: () => finish(null) };
    doc.addEventListener("mousemove", move, true);
    doc.addEventListener("click", click, true);
    doc.addEventListener("keydown", key, true);
    for (const type of blocked) doc.addEventListener(type, swallow, true);
  });
})()`
}

/** 取消页面里还在进行的选择。 */
export const CANCEL_PICKER_SCRIPT = "window.__pigcodePick?.cancel()"

/** 判断脚本的结果是不是一个选中的元素。 */
export function isPickedElement(value: unknown): value is PickedElement {
  if (typeof value !== "object" || value === null) return false
  const picked = value as Partial<PickedElement>
  return (
    typeof picked.url === "string" &&
    typeof picked.tag === "string" &&
    typeof picked.selector === "string" &&
    typeof picked.html === "string"
  )
}

/** 选中的元素变成输入框上方的附件：简称是标签和文字，内容是一段 Markdown。 */
export function elementContext(
  picked: PickedElement,
  t: (key: MessageKey) => string,
): ComposerContext {
  const line = (key: MessageKey, value: string) => t(key).replace("{value}", value)
  const summary = picked.name ?? picked.text
  const label = summary ? `<${picked.tag}> ${summary.slice(0, 32)}` : `<${picked.tag}>`
  const markdown = [
    `### ${t("browser.context.heading").replace("{page}", picked.title || picked.url)}`,
    "",
    `- ${line("browser.context.url", picked.url)}`,
    `- ${line("browser.context.selector", `\`${picked.selector}\``)}`,
    ...(picked.text ? [`- ${line("browser.context.text", picked.text)}`] : []),
    `- ${line("browser.context.size", `${picked.size.width}×${picked.size.height}`)}`,
    `- ${line("browser.context.style", picked.style)}`,
    "",
    "```html",
    picked.html,
    "```",
  ].join("\n")
  return {
    id: `element:${picked.url}#${picked.selector}`,
    label,
    title: `${picked.selector}\n${picked.url}`,
    markdown,
  }
}
