/** 设置导航的搜索弹层。从同一个设置页注册表生成结果。 */
import { useMemo, useRef, useState } from "react"
import { Search, X } from "lucide-react"
import { contributionText, type SettingsPageContribution } from "@pigcode/client-runtime"
import { Autocomplete, Button, Dialog, EmptyState, useLocale } from "@pigcode/ui-primitives"

export function SettingsSearch({
  builtin,
  plugins,
  onSelect,
}: {
  builtin: readonly SettingsPageContribution[]
  plugins: readonly SettingsPageContribution[]
  onSelect: (page: string) => void
}) {
  const { t } = useLocale()
  const title = t("settings.search")
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const input = useRef<HTMLInputElement>(null)
  const selected = useRef<string | null>(null)
  const groups = useMemo(
    () =>
      [
        { label: t("settings.title"), items: builtin },
        { label: t("settings.pluginPages"), items: plugins },
      ].filter((group) => group.items.length > 0),
    [builtin, plugins, t],
  )
  const labelOf = (page: SettingsPageContribution) => contributionText(t, page.title)

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next, details) => {
        if (!next && details.reason === "escape-key") {
          const event = details.event
          if (event instanceof KeyboardEvent && (event.isComposing || event.keyCode === 229)) {
            details.cancel()
            return
          }
          if (query) {
            details.cancel()
            setQuery("")
            return
          }
        }
        if (next) {
          setQuery("")
          selected.current = null
        }
        setOpen(next)
      }}
      onOpenChangeComplete={(next) => {
        // 等弹层释放焦点后再进入设置页。
        if (next || selected.current === null) return
        const page = selected.current
        selected.current = null
        onSelect(page)
      }}
    >
      <Dialog.Trigger render={<Button variant="ghost" className="settings-search-trigger" />}>
        <Search className="ic" aria-hidden="true" />
        <span className="truncate">{title}</span>
      </Dialog.Trigger>
      <Dialog.Content
        title={title}
        closeLabel={t("common.close")}
        hideHeader
        className="settings-search-dialog"
        initialFocus={input}
      >
        <Autocomplete.Root
          inline
          open
          autoHighlight="always"
          keepHighlight
          items={groups}
          itemToStringValue={labelOf}
          value={query}
          onValueChange={setQuery}
        >
          <div className="palette-search">
            <Autocomplete.InputGroup className="search-field" data-size="lg" data-variant="plain">
              <Search className="ic search-field-icon" aria-hidden="true" />
              <Autocomplete.Input
                ref={input}
                type="search"
                aria-label={title}
                placeholder={title}
                spellCheck={false}
              />
              <Autocomplete.Clear
                render={<Button size="icon-sm" variant="ghost" />}
                aria-label={t("settings.clear")}
              >
                <X className="ic" aria-hidden="true" />
              </Autocomplete.Clear>
            </Autocomplete.InputGroup>
          </div>
          <Autocomplete.List className="palette-list" aria-label={title}>
            {(group: (typeof groups)[number]) => (
              <Autocomplete.Group key={group.label} items={group.items}>
                <Autocomplete.GroupLabel className="palette-group">
                  {group.label}
                </Autocomplete.GroupLabel>
                <Autocomplete.Collection>
                  {(page: SettingsPageContribution) => (
                    <Autocomplete.Item
                      key={page.id}
                      value={page}
                      onClick={() => {
                        if (!open) return
                        selected.current = page.id
                        setOpen(false)
                      }}
                    >
                      <page.icon className="ic" aria-hidden="true" />
                      <span className="truncate">{labelOf(page)}</span>
                    </Autocomplete.Item>
                  )}
                </Autocomplete.Collection>
              </Autocomplete.Group>
            )}
          </Autocomplete.List>
          <Autocomplete.Empty>
            <EmptyState size="compact" title={t("settings.noMatches")} />
          </Autocomplete.Empty>
        </Autocomplete.Root>
      </Dialog.Content>
    </Dialog.Root>
  )
}
