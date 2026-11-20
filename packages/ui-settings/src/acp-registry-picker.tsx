import { useEffect, useState } from "react"
import type { AcpRegistryEntry } from "@pigcode/contracts"
import { Button, SearchField, useLocale } from "@pigcode/ui-primitives"

export function AcpRegistryPicker({
  load,
  selected,
  localSelected,
  onUseLocal,
  onSelect,
}: {
  load: () => Promise<AcpRegistryEntry[]>
  selected: unknown
  localSelected: boolean
  onUseLocal: () => void
  onSelect: (entry: AcpRegistryEntry) => void
}) {
  const { t } = useLocale()
  const [query, setQuery] = useState("")
  const [entries, setEntries] = useState<AcpRegistryEntry[]>()
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    void load().then(
      (values) => {
        if (active) setEntries(values)
      },
      () => {
        if (active) setError(true)
      },
    )
    return () => {
      active = false
    }
  }, [load])
  const keyword = query.trim().toLowerCase()
  const matches = entries?.filter((entry) =>
    `${entry.name} ${entry.id}`.toLowerCase().includes(keyword),
  )
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <div className="grow">
          <SearchField
            size="lg"
            value={query}
            onValueChange={setQuery}
            placeholder={t("agents.acp.search")}
          />
        </div>
        <Button
          size="sm"
          type="button"
          variant={localSelected ? "primary" : "secondary"}
          aria-pressed={localSelected}
          onClick={onUseLocal}
        >
          {t("agents.acp.useLocal")}
        </Button>
      </div>
      {error ? (
        <p className="error-text" role="alert">
          {t("agents.acp.failed")}
        </p>
      ) : !matches ? (
        <p role="status">{t("agents.acp.loading")}</p>
      ) : matches.length === 0 ? (
        <p className="agent-muted">{t("agents.instance.noMatches")}</p>
      ) : (
        <div className="wizard-agents" role="listbox" aria-label={t("agents.acp.registry")}>
          {matches.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="option"
              aria-selected={entry.id === selected}
              className="wizard-agent"
              onClick={() => onSelect(entry)}
            >
              <span className="wizard-agent-text">
                <span className="truncate">{entry.name}</span>
                <span className="agent-muted truncate">{entry.description}</span>
                <span className="agent-muted truncate">
                  {[entry.version, entry.license].filter(Boolean).join(" · ")}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}
