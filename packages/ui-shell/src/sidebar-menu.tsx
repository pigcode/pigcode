/**
 * 「项目」标题旁的「自定义侧栏」菜单，照 Cursor：分组、排序、显示三个子菜单；筛选一段（状态、已归档，
 * 偏离默认时有「重置」）；最后是全部标为已读。单选和勾选不关菜单，项目的排序和全部标为已读选完就关。
 * Cursor 还能按工作区、环境、来源分组，按 PR、环境、来源筛选，Pigcode 没有这些数据，不放。
 */
import type { ReactNode } from "react"
import {
  Menu,
  SIDEBAR_STATUS_FILTERS,
  useLocale,
  type MessageKey,
  type SidebarGrouping,
  type SidebarProjectOrder,
  type SidebarStatusFilter,
  type SidebarThreadOrder,
  type SidebarView,
} from "@pigcode/ui-primitives"
import { Icon } from "./icon"
import { filtersActive } from "./sidebar-arrangement"

/** 状态筛选各项的图标，和 Cursor 的一样。 */
const STATUS_ICON: Record<SidebarStatusFilter, string> = {
  attention: "alert-circle",
  error: "x-circle",
  unread: "bell",
  working: "loader",
  draft: "circle-dashed",
  done: "check-circle",
}

/** 打开子菜单的一行，右侧可带当前值，筛选偏离默认时带一个小圆点；子菜单的第一项和这一行对齐。 */
function Submenu({
  label,
  value,
  changed = false,
  children,
}: {
  label: string
  value?: string | undefined
  changed?: boolean
  children: ReactNode
}) {
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger>
        <span className="grow">{label}</span>
        {value ? <span className="menu-meta">{value}</span> : null}
        {changed ? <span className="menu-dot" aria-hidden="true" /> : null}
        <Icon name="right" small className="menu-submenu-chevron" />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} alignOffset={-6}>
          <Menu.Popup className="sidebar-menu">{children}</Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  )
}

/** 单选的一项：图标、名字，选中时行尾一个对勾。 */
function Choice({
  value,
  icon,
  label,
  closeOnClick = false,
}: {
  value: string
  icon: string
  label: string
  closeOnClick?: boolean
}) {
  return (
    <Menu.RadioItem value={value} closeOnClick={closeOnClick}>
      <Icon name={icon} />
      <span className="grow">{label}</span>
      <Menu.RadioItemIndicator className="menu-indicator">
        <Icon name="check" small className="check-mark" />
      </Menu.RadioItemIndicator>
    </Menu.RadioItem>
  )
}

/** 勾选的一项。 */
function Toggle({
  checked,
  icon,
  label,
  onChange,
}: {
  checked: boolean
  icon?: string
  label: string
  onChange: (checked: boolean) => void
}) {
  return (
    <Menu.CheckboxItem checked={checked} onCheckedChange={onChange}>
      {icon ? <Icon name={icon} /> : null}
      <span className="grow">{label}</span>
      <Menu.CheckboxItemIndicator className="menu-indicator">
        <Icon name="check" small className="check-mark" />
      </Menu.CheckboxItemIndicator>
    </Menu.CheckboxItem>
  )
}

/** 会话的排序：更新时间或状态。 */
function ThreadOrder({
  value,
  onChange,
  label,
}: {
  value: SidebarThreadOrder
  onChange: (value: SidebarThreadOrder) => void
  label?: string
}) {
  const { t } = useLocale()
  return (
    <Menu.RadioGroup value={value} onValueChange={(next: SidebarThreadOrder) => onChange(next)}>
      {label ? <Menu.Label>{label}</Menu.Label> : null}
      <Choice value="updated" icon="clock" label={t("sidebar.option.updated")} />
      <Choice value="status" icon="circle-dashed" label={t("sidebar.option.status")} />
    </Menu.RadioGroup>
  )
}

export function SidebarMenu({
  grouping,
  view,
  unread,
  onGrouping,
  onView,
  onMarkAllRead,
}: {
  grouping: SidebarGrouping
  view: SidebarView
  /** 有没有未读的会话；没有时「全部标为已读」不可点。 */
  unread: boolean
  onGrouping: (value: SidebarGrouping) => void
  onView: (patch: Partial<SidebarView>) => void
  onMarkAllRead?: (() => void) | undefined
}) {
  const { t } = useLocale()
  const groupings = [
    { id: "project", icon: "folder", label: t("sidebar.option.project") },
    { id: "time", icon: "clock", label: t("sidebar.option.updated") },
    { id: "status", icon: "circle-dashed", label: t("sidebar.option.status") },
  ] as const
  const filtering = filtersActive(view)
  const statusFiltered = view.statusFilter.length < SIDEBAR_STATUS_FILTERS.length
  const toggleStatus = (option: SidebarStatusFilter, checked: boolean) =>
    onView({
      statusFilter: checked
        ? [...view.statusFilter, option]
        : view.statusFilter.filter((item) => item !== option),
    })
  return (
    <Menu.Root>
      <Menu.Trigger
        className="icon-btn side-filter"
        type="button"
        data-active={filtering ? "" : undefined}
        aria-label={t("sidebar.customize")}
        title={t("sidebar.customize")}
      >
        <Icon name="sidebar-customize" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="right" align="start" sideOffset={6}>
          <Menu.Popup className="sidebar-menu" aria-label={t("sidebar.filters")}>
            <Submenu
              label={t("sidebar.groupBy")}
              value={groupings.find((option) => option.id === grouping)?.label}
            >
              <Menu.RadioGroup
                value={grouping}
                onValueChange={(value: SidebarGrouping) => onGrouping(value)}
              >
                {groupings.map((option) => (
                  <Choice
                    key={option.id}
                    value={option.id}
                    icon={option.icon}
                    label={option.label}
                  />
                ))}
              </Menu.RadioGroup>
            </Submenu>
            <Submenu label={t("sidebar.orderBy")}>
              {grouping === "project" ? (
                <>
                  <ThreadOrder
                    label={t("sidebar.orderThreads")}
                    value={view.threadOrder}
                    onChange={(threadOrder) => onView({ threadOrder })}
                  />
                  <Menu.Separator />
                  <Menu.RadioGroup
                    value={view.projectOrder}
                    onValueChange={(value: SidebarProjectOrder) => onView({ projectOrder: value })}
                  >
                    <Menu.Label>{t("sidebar.orderProjects")}</Menu.Label>
                    <Choice
                      value="updated"
                      icon="clock"
                      label={t("sidebar.option.updated")}
                      closeOnClick
                    />
                    <Choice
                      value="manual"
                      icon="updown"
                      label={t("sidebar.option.manual")}
                      closeOnClick
                    />
                  </Menu.RadioGroup>
                </>
              ) : (
                <ThreadOrder
                  value={view.threadOrder}
                  onChange={(threadOrder) => onView({ threadOrder })}
                />
              )}
            </Submenu>
            <Submenu label={t("sidebar.show")}>
              <Toggle
                checked={view.showTime}
                icon="clock"
                label={t("sidebar.option.updated")}
                onChange={(showTime) => onView({ showTime })}
              />
              {grouping !== "project" ? (
                <>
                  <Menu.Separator />
                  <Toggle
                    checked={view.showProject}
                    icon="folder"
                    label={t("sidebar.option.project")}
                    onChange={(showProject) => onView({ showProject })}
                  />
                </>
              ) : null}
            </Submenu>
            <Menu.Separator />
            <Menu.Group>
              <div className="sidebar-menu-head">
                <Menu.Label>{t("sidebar.filter")}</Menu.Label>
                {filtering ? (
                  <Menu.Item
                    className="sidebar-menu-reset"
                    closeOnClick={false}
                    onClick={() =>
                      onView({ archived: false, statusFilter: [...SIDEBAR_STATUS_FILTERS] })
                    }
                  >
                    {t("sidebar.filter.reset")}
                  </Menu.Item>
                ) : null}
              </div>
              <Submenu label={t("sidebar.option.status")} changed={statusFiltered}>
                {SIDEBAR_STATUS_FILTERS.map((option) => (
                  <Toggle
                    key={option}
                    checked={view.statusFilter.includes(option)}
                    icon={STATUS_ICON[option]}
                    label={t(`sidebar.status.${option}` as MessageKey)}
                    onChange={(checked) => toggleStatus(option, checked)}
                  />
                ))}
              </Submenu>
              <Toggle
                checked={view.archived}
                label={t("sidebar.filter.archived")}
                onChange={(archived) => onView({ archived })}
              />
            </Menu.Group>
            {onMarkAllRead ? (
              <>
                <Menu.Separator />
                <Menu.Item disabled={!unread} onClick={onMarkAllRead}>
                  <span className="grow">{t("sidebar.markAllRead")}</span>
                </Menu.Item>
              </>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
