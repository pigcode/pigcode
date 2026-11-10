/**
 * 输入框工具栏里的模型与权限：有可选 Agent 时是模型选择器（权限在它的底栏里），
 * 没有时只剩一个权限胶囊。开启完全访问的确认框画在选择器外面。
 */
import type {
  ComposerAgent,
  ComposerModelCatalog,
  ComposerModelChoice,
  PermissionMode,
} from "./composer-options"
import { ModelPicker } from "./model-picker"
import { PermissionMenu, usePermissionChange } from "./permission-menu"

export interface ComposerModelControlsProps {
  agents: readonly ComposerAgent[]
  agentId: string | null
  modelId: string | null
  catalog: ComposerModelCatalog
  onLoadModels?: ((instanceId: string) => void) | undefined
  onSelectModel: (choice: ComposerModelChoice) => void
  /** 调用方允许切换模型。 */
  selectable: boolean
  permissionMode: PermissionMode
  permissionModes: readonly PermissionMode[]
  onPermissionMode?: ((mode: PermissionMode) => void) | undefined
  running: boolean
  side: "top" | "bottom"
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** 画出模型选择器或单独的权限胶囊。 */
export function ComposerModelControls({
  agents,
  agentId,
  modelId,
  catalog,
  onLoadModels,
  onSelectModel,
  selectable,
  permissionMode,
  permissionModes,
  onPermissionMode,
  running,
  side,
  open,
  onOpenChange,
}: ComposerModelControlsProps) {
  const permission = usePermissionChange(permissionMode, onPermissionMode)
  if (agents.length === 0) {
    return (
      <PermissionMenu
        value={permissionMode}
        modes={permissionModes}
        onChange={onPermissionMode}
        side={side}
      />
    )
  }
  return (
    <>
      <ModelPicker
        agents={agents}
        agentId={agentId}
        modelId={modelId}
        catalog={catalog}
        onLoadModels={onLoadModels}
        onSelectModel={onSelectModel}
        permissionMode={permissionMode}
        permissionModes={permissionModes}
        onPermissionMode={
          onPermissionMode
            ? (mode) => {
                // 完全访问的确认框画在选择器外面，先把选择器关掉。
                if (mode === "danger-full-access") onOpenChange(false)
                permission.request(mode)
              }
            : undefined
        }
        locked={running || !selectable}
        side={side}
        open={open}
        onOpenChange={onOpenChange}
      />
      {permission.dialog}
    </>
  )
}
