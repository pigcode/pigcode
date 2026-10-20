// 负责把 TipTap Typography 的输入规则接到一个可运行时开关上，让输入区不必重建编辑器。
import { InputRule } from "@tiptap/react"
import Typography from "@tiptap/extension-typography"

/** 判断光标前的文本是否停在尚未闭合的反引号内，此时输入多半属于即将成为行内代码的内容。 */
export function insideOpenBacktick(textBefore: string): boolean {
  return (textBefore.match(/`/g)?.length ?? 0) % 2 === 1
}

/**
 * 包装输入规则列表：开关为关时规则的 handler 返回 null，TipTap 会放弃替换，输入原样保留。
 * 另外，位于未闭合反引号之后的输入也不替换，避免 `--flag` 在闭合成行内代码之前被改写。
 * 保证不改变规则的匹配条件和 undoable 行为，开关每次触发输入时才读取。
 */
export function gateInputRules(rules: readonly InputRule[], isEnabled: () => boolean): InputRule[] {
  return rules.map(
    (rule) =>
      new InputRule({
        find: rule.find,
        undoable: rule.undoable,
        handler: (props) => {
          if (!isEnabled()) return null
          const { parent, parentOffset } = props.state.doc.resolve(props.range.from)
          if (insideOpenBacktick(parent.textBetween(0, parentOffset, undefined, "\ufffc"))) {
            return null
          }
          return rule.handler(props)
        },
      }),
  )
}

/**
 * 创建带运行时开关的 Typography 扩展。扩展实例在编辑器生命周期内保持不变，
 * 切换开关只改 isEnabled 的返回值，因此正文、焦点、撤销历史和其他扩展状态都不受影响。
 * 代码标记与代码块里的输入由 TipTap 的输入规则运行时自行跳过。
 */
export function createSmartPunctuation(isEnabled: () => boolean) {
  return Typography.extend({
    addInputRules() {
      return gateInputRules(this.parent?.() ?? [], isEnabled)
    },
  })
}
