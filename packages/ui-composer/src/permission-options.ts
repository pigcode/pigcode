import { Ban, Eye, Hand, Pencil, ShieldAlert, Sparkles, type LucideIcon } from "lucide-react"
import { localizeText, type AgentPermissionMode } from "@pigcode/contracts"

export const PERMISSION_ICONS: Record<AgentPermissionMode["kind"], LucideIcon> = {
  ask: Hand,
  edit: Pencil,
  auto: Sparkles,
  "read-only": Eye,
  "full-access": ShieldAlert,
  deny: Ban,
}
export const permissionNeedsConfirmation = (mode: AgentPermissionMode) =>
  mode.requiresConfirmation === true || mode.kind === "full-access"
export const permissionLabel = (mode: AgentPermissionMode | undefined, locale: string) =>
  mode ? localizeText(mode.label, locale) : "—"
export const permissionDescription = (mode: AgentPermissionMode, locale: string) =>
  localizeText(mode.description, locale)
export const permissionIcon = (mode: AgentPermissionMode | undefined) =>
  PERMISSION_ICONS[mode?.kind ?? "ask"]

export function nextPermissionMode(current: string, modes: readonly AgentPermissionMode[]): string {
  const cycle = modes.filter((mode) => !mode.hidden && !permissionNeedsConfirmation(mode))
  const index = cycle.findIndex((mode) => mode.id === current)
  return cycle[(index + 1) % cycle.length]?.id ?? current
}
