/** 多主机识别小圆点、彩色主机名标签与在线主机下拉选择器。 */
import { Check, ChevronDown } from "lucide-react"
import type { HostBadgeColor, HostSummary } from "@pigcode/contracts"
import { useLocale } from "../locale/locale"
import { cn } from "./cn"
import { Menu } from "./menu"

export const HOST_COLOR_OPTIONS: readonly HostBadgeColor[] = [
  "blue",
  "green",
  "amber",
  "violet",
  "rose",
  "slate",
]

export function hostDisplayName(
  host: Pick<HostSummary, "id" | "name" | "kind">,
  localFallback: string,
): string {
  if (host.kind === "local" && (!host.name || host.name === "Local Host")) {
    return localFallback
  }
  return host.name || localFallback
}

export function HostDot({
  color,
  offline = false,
  className,
}: {
  color: HostBadgeColor
  offline?: boolean | undefined
  className?: string | undefined
}) {
  return (
    <span
      className={cn("host-dot", className)}
      data-host-color={color}
      data-offline={offline ? "" : undefined}
      aria-hidden="true"
    />
  )
}

export function HostBadge({
  host,
  className,
  showOffline = false,
}: {
  host: HostSummary
  className?: string | undefined
  showOffline?: boolean | undefined
}) {
  const { t } = useLocale()
  const offline = host.status !== "connected"
  const name = hostDisplayName(host, t("hosts.localTag"))
  return (
    <span
      className={cn("host-chip", className)}
      data-host-color={host.badgeColor}
      data-offline={offline ? "" : undefined}
      title={offline ? `${name} · ${t("hosts.offlineBadge")}` : name}
    >
      <HostDot color={host.badgeColor} offline={offline} />
      <span className="truncate">{name}</span>
      {showOffline && offline ? <span>· {t("hosts.offlineBadge")}</span> : null}
    </span>
  )
}

export function HostPickerMenu({
  hosts,
  value,
  onChange,
  onlineOnly = false,
  disabled = false,
  label,
  className,
}: {
  hosts: readonly HostSummary[]
  value: string
  onChange: (hostId: string) => void
  onlineOnly?: boolean | undefined
  disabled?: boolean | undefined
  label?: string | undefined
  className?: string | undefined
}) {
  const { t } = useLocale()
  const active = hosts.find((h) => h.id === value) ?? hosts[0]
  if (!active) return null
  const activeName = hostDisplayName(active, t("hosts.localTag"))
  return (
    <Menu.Root>
      <Menu.Trigger
        type="button"
        className={cn("chip-btn", className)}
        disabled={disabled}
        aria-label={label ?? t("hosts.targetHost")}
        title={label ?? t("hosts.targetHost")}
      >
        <HostDot color={active.badgeColor} offline={active.status !== "connected"} />
        <span className="truncate">{activeName}</span>
        <ChevronDown className="ic chip-caret" aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={6}>
          <Menu.Popup>
            <Menu.RadioGroup value={active.id} onValueChange={(nextId) => onChange(nextId)}>
              {hosts.map((host) => {
                const offline = host.status !== "connected"
                const name = hostDisplayName(host, t("hosts.localTag"))
                const itemDisabled = onlineOnly && offline
                return (
                  <Menu.RadioItem
                    key={host.id}
                    value={host.id}
                    disabled={itemDisabled}
                    closeOnClick
                  >
                    <HostDot color={host.badgeColor} offline={offline} />
                    <span className="grow truncate">{name}</span>
                    {offline ? (
                      <span className="menu-meta">{t("hosts.offlineBadge")}</span>
                    ) : host.id === "local" ? (
                      <span className="menu-meta">{t("hosts.localTag")}</span>
                    ) : null}
                    <Menu.RadioItemIndicator className="menu-indicator">
                      <Check className="ic ic-sm check-mark" aria-hidden="true" />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                )
              })}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
