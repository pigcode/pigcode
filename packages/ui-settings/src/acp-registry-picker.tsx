import { useEffect, useState } from "react"
import { ExternalLink, Terminal } from "lucide-react"
import type { AcpRegistryEntry } from "@pigcode/contracts"
import { Button, SearchField, useLocale } from "@pigcode/ui-primitives"

export function RegistryIcon({ entry }: { entry: AcpRegistryEntry }) {
  const [failed, setFailed] = useState<string>()
  return (
    <span className="acp-registry-icon" aria-hidden="true">
      {entry.icon && entry.icon !== failed ? (
        <img
          src={entry.icon}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(entry.icon)}
        />
      ) : (
        <Terminal className="ic" />
      )}
    </span>
  )
}

export interface RegistryActions {
  list: () => Promise<AcpRegistryEntry[]>
  prepare: (registryId: string) => Promise<AcpRegistryEntry>
}

export function AcpRegistryPicker({
  load,
  added,
  preparing,
  failure,
  onAdd,
  onManual,
  onLocal,
  openExternal,
}: {
  load: () => Promise<AcpRegistryEntry[]>
  added: ReadonlySet<string>
  preparing: string | null
  failure: { id: string; message: string } | null
  onAdd: (entry: AcpRegistryEntry) => void
  onManual: () => void
  onLocal: () => void
  openExternal?: ((url: string) => void | Promise<void>) | undefined
}) {
  const { t } = useLocale()
  const [query, setQuery] = useState("")
  const [entries, setEntries] = useState<AcpRegistryEntry[]>()
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let live = true
    setFailed(false)
    void load().then(
      (result) => {
        if (live) setEntries(result)
      },
      () => {
        if (live) setFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [load, revision])
  const keyword = query.trim().toLowerCase()
  const matches = entries?.filter((entry) =>
    (entry.name + " " + entry.id).toLowerCase().includes(keyword),
  )
  return (
    <section className="acp-registry" aria-label={t("agents.acp.registry")}>
      <div className="acp-registry-heading">{t("agents.acp.registry")}</div>
      <div className="acp-registry-tools">
        <SearchField
          size="default"
          value={query}
          onValueChange={setQuery}
          placeholder={t("agents.acp.search")}
        />
        <Button
          size="sm"
          variant="ghost"
          type="button"
          disabled={preparing !== null}
          onClick={onManual}
        >
          {t("agents.acp.manual")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          type="button"
          disabled={preparing !== null}
          onClick={onLocal}
        >
          {t("agents.acp.useLocal")}
        </Button>
      </div>
      {failed ? (
        <div className="acp-registry-notice" role="alert">
          {t("agents.acp.failed")}
          <Button size="sm" variant="ghost" onClick={() => setRevision((n) => n + 1)}>
            {t("agents.cli.retry")}
          </Button>
        </div>
      ) : !matches ? (
        <p className="acp-registry-notice" role="status">
          {t("agents.acp.loading")}
        </p>
      ) : matches.length === 0 ? (
        <p className="acp-registry-notice">{t("agents.instance.noMatches")}</p>
      ) : (
        <ul className="acp-registry-list" aria-label={t("agents.acp.registry")}>
          {matches.map((entry) => {
            const busy = preparing === entry.id
            const exists = added.has(entry.id)
            const failedRow = failure?.id === entry.id
            const about = entry.website || entry.repository
            const label = t(
              exists
                ? "agents.acp.added"
                : busy
                  ? entry.distribution === "binary"
                    ? "agents.acp.downloading"
                    : "agents.acp.preparing"
                  : failedRow
                    ? "agents.cli.retry"
                    : "agents.acp.add",
            )
            return (
              <li key={entry.id} className="acp-registry-item">
                <div className="acp-registry-row">
                  <RegistryIcon entry={entry} />
                  <div className="acp-registry-copy">
                    <span className="acp-registry-name truncate">{entry.name}</span>
                    <span className="acp-registry-description truncate" title={entry.description}>
                      {entry.description}
                    </span>
                  </div>
                  <div className="acp-registry-actions">
                    {about && openExternal && (
                      <Button
                        size="sm"
                        variant="ghost"
                        type="button"
                        aria-label={t("agents.acp.about").replace("{name}", entry.name)}
                        onClick={() => void openExternal(about)}
                      >
                        <ExternalLink className="ic ic-sm" aria-hidden="true" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      type="button"
                      className="acp-registry-add"
                      aria-label={label + " " + entry.name}
                      aria-busy={busy}
                      disabled={exists || preparing !== null}
                      onClick={() => onAdd(entry)}
                    >
                      {label}
                    </Button>
                  </div>
                </div>
                {failedRow && (
                  <p className="acp-registry-error error-text" role="alert">
                    {failure.message}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
