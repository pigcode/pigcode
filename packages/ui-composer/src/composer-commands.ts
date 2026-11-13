import type { AgentPermissionMode } from "@pigcode/contracts"
import type { MessageKey } from "@pigcode/ui-primitives"
import type { ComposerCommand } from "./composer-editor"
import { permissionLabel, permissionNeedsConfirmation } from "./permission-options"

/** 命令和菜单读取同一份平台权限定义；计划命令只改变独立的计划开关。 */
export function composerCommands(input: {
  locale: string
  t: (key: MessageKey) => string
  hasAgents: boolean
  modes: readonly AgentPermissionMode[]
  openModels: () => void
  onPermissionMode: ((mode: string) => void) | undefined
  planMode: boolean
  onPlanMode: ((value: boolean) => void) | undefined
}): ComposerCommand[] {
  const { t } = input
  return [
    ...(input.onPlanMode
      ? [
          {
            id: "plan",
            label: "/plan",
            description: t("composer.permission.plan"),
            run: () => input.onPlanMode!(!input.planMode),
          },
        ]
      : []),
    ...(input.hasAgents
      ? [
          {
            id: "model",
            label: "/model",
            description: t("composer.command.model"),
            keywords: [t("composer.command.model.keyword")],
            run: input.openModels,
          },
        ]
      : []),
    ...(input.onPermissionMode
      ? input.modes
          .filter((mode) => !permissionNeedsConfirmation(mode) && !mode.hidden)
          .map((mode) => ({
            id: `permission-${mode.id}`,
            label: `/${mode.command ?? mode.id}`,
            description: permissionLabel(mode, input.locale),
            run: () => input.onPermissionMode!(mode.id),
          }))
      : []),
  ]
}
