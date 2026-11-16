import { parse, stringify } from "yaml"
import { useLocale } from "@pigcode/ui-primitives"
import type { ClientPluginContext } from "@pigcode/plugin-sdk"
import { TransformPanel } from "../../transform-panel.tsx"

const modes = [
  { value: "to-json", label: "YAML → JSON" },
  { value: "to-yaml", label: "JSON → YAML" },
] as const

function YamlJson() {
  const { locale } = useLocale()
  const chinese = locale === "zh-CN"
  return (
    <TransformPanel
      modes={modes}
      initialMode="to-json"
      modeLabel={chinese ? "转换方向" : "Conversion direction"}
      runLabel={chinese ? "转换" : "Convert"}
      transform={(source, mode) =>
        mode === "to-json"
          ? JSON.stringify(parse(source, { maxAliasCount: 50 }), null, 2) + "\n"
          : stringify(JSON.parse(source))
      }
    />
  )
}

export function apply(ctx: ClientPluginContext): () => void {
  return ctx.surfaces.register({
    id: "pigcode.yaml-json",
    title: ctx.locale.get() === "zh-CN" ? "YAML ↔ JSON 转换" : "YAML ↔ JSON",
    Component: YamlJson,
  })
}
