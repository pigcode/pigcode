import { format } from "prettier/standalone"
import babel from "prettier/plugins/babel"
import estree from "prettier/plugins/estree"
import postcss from "prettier/plugins/postcss"
import typescript from "prettier/plugins/typescript"
import { useLocale } from "@pigcode/ui-primitives"
import type { ClientPluginContext } from "@pigcode/plugin-sdk"
import { TransformPanel } from "../../transform-panel.tsx"

const modes = [
  { value: "babel", label: "JS" },
  { value: "typescript", label: "TS" },
  { value: "json", label: "JSON" },
  { value: "css", label: "CSS" },
] as const

function PrettierFormat() {
  const { locale } = useLocale()
  const chinese = locale === "zh-CN"
  return (
    <TransformPanel
      modes={modes}
      initialMode="babel"
      modeLabel={chinese ? "代码语言" : "Code language"}
      runLabel={chinese ? "格式化" : "Format"}
      transform={(source, parser) =>
        format(source, { parser, plugins: [babel, estree, postcss, typescript] })
      }
    />
  )
}

export function apply(ctx: ClientPluginContext): () => void {
  return ctx.surfaces.register({
    id: "pigcode.prettier-format",
    title: ctx.locale.get() === "zh-CN" ? "Prettier 格式化" : "Prettier Format",
    Component: PrettierFormat,
  })
}
