import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react"
import { ArrowRight, Check, ExternalLink, LoaderCircle, Terminal } from "lucide-react"
import { localizeText, type AcpRegistryEntry, type AgentSummary } from "@pigcode/contracts"
import { AgentIcon, Button, SearchField, useLocale } from "@pigcode/ui-primitives"

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
        <Terminal className="ic ic-sm" />
      )}
    </span>
  )
}

export interface RegistryActions {
  list: () => Promise<AcpRegistryEntry[]>
  prepare: (registryId: string) => Promise<AcpRegistryEntry>
}

type Row = { key: string; name: string } & ({ agent: AgentSummary } | { entry: AcpRegistryEntry })

export function AgentDirectory({
  agents,
  preferredId,
  registry,
  local,
  added,
  preparing,
  failure,
  query,
  onQuery,
  onAgent,
  onAdd,
  onLocal,
  onManual,
  openExternal,
}: {
  agents: readonly AgentSummary[]
  preferredId?: string | null | undefined
  registry?: RegistryActions | undefined
  local: boolean
  added: ReadonlySet<string>
  preparing: string | null
  failure: { id: string; message: string } | null
  query: string
  onQuery: (query: string) => void
  onAgent: (agent: AgentSummary) => void
  onAdd: (id: string) => void
  onLocal: () => void
  onManual: () => void
  openExternal?: ((url: string) => void | Promise<void>) | undefined
}) {
  const { locale, t } = useLocale()
  const listId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [highlight, setHighlight] = useState<string | null>(
    preferredId ? "agent-" + preferredId : null,
  )
  const [entries, setEntries] = useState<AcpRegistryEntry[]>()
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const load = registry?.list
  useEffect(() => {
    if (!load) return
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
  }, [load, retry])
  const search = query.trim().toLowerCase()
  const matches = (name: string, id: string) => (name + " " + id).toLowerCase().includes(search)
  const native: Row[] = agents
    .filter((agent) => matches(agent.displayName, agent.agentId))
    .map((agent) => ({ key: "agent-" + agent.agentId, name: agent.displayName, agent }))
  const remote: Row[] = (load ? (entries ?? []) : [])
    .filter((entry) => matches(entry.name, entry.id))
    .map((entry) => ({ key: "registry-" + entry.id, name: entry.name, entry }))
  const selectable = [...native, ...remote].filter(
    (row) => !("entry" in row && added.has(row.entry.id)),
  )
  const active = selectable.find((row) => row.key === highlight) ?? selectable[0]
  const pending = preparing !== null
  function choose(row: Row) {
    if (pending) return
    if ("agent" in row) onAgent(row.agent)
    else if (!added.has(row.entry.id)) onAdd(row.entry.id)
  }
  function move(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing || !active || pending) return
    if (event.key === "Enter") {
      if (event.currentTarget !== input.current) return
      event.preventDefault()
      choose(active)
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const next =
        selectable[
          (selectable.indexOf(active) + (event.key === "ArrowDown" ? 1 : -1) + selectable.length) %
            selectable.length
        ]!
      setHighlight(next.key)
      const element = document.getElementById(listId + next.key)
      if (event.currentTarget !== input.current) element?.focus({ preventScroll: true })
      element?.scrollIntoView?.({ block: "nearest" })
    }
  }
  function group(label: string, rows: Row[]) {
    if (!rows.length) return null
    return (
      <div role="group" aria-label={label} className="agent-directory-group">
        <p className="agent-directory-heading" aria-hidden="true">
          <span>{label}</span>
          <span className="agent-directory-count agent-tabular">{rows.length}</span>
        </p>
        {rows.map((row) => {
          const entry = "entry" in row ? row.entry : null
          const exists = Boolean(entry && added.has(entry.id))
          const busy = Boolean(entry && entry.id === preparing)
          const error = entry && failure?.id === entry.id ? failure.message : null
          const action = entry
            ? t(
                exists
                  ? "agents.acp.added"
                  : busy
                    ? entry.distribution === "binary"
                      ? "agents.acp.downloading"
                      : "agents.acp.preparing"
                    : error
                      ? "agents.cli.retry"
                      : "agents.acp.add",
              )
            : undefined
          const link = entry?.website || entry?.repository
          const description = entry
            ? entry.description
            : "agent" in row && row.agent.description
              ? localizeText(row.agent.description, locale)
              : null
          return (
            <div
              key={row.key}
              className="agent-directory-entry"
              data-active={active?.key === row.key || undefined}
            >
              <button
                id={listId + row.key}
                type="button"
                role="option"
                aria-selected={active?.key === row.key}
                aria-label={action ? action + " " + row.name : row.name}
                aria-busy={busy}
                disabled={exists || pending}
                className="agent-directory-option"
                tabIndex={active?.key === row.key ? 0 : -1}
                onKeyDown={move}
                onFocus={() => setHighlight(row.key)}
                onPointerMove={() => {
                  if (!pending && !exists) setHighlight(row.key)
                }}
                onClick={() => choose(row)}
              >
                <span className="agent-directory-tile" aria-hidden="true">
                  {"agent" in row ? (
                    <AgentIcon agentId={row.agent.agentId} name={row.name} size="lg" />
                  ) : (
                    <RegistryIcon entry={row.entry} />
                  )}
                </span>
                <span className="agent-directory-copy">
                  <span className="agent-directory-name truncate">{row.name}</span>
                  {description ? (
                    <span className="agent-directory-description truncate" title={description}>
                      {description}
                    </span>
                  ) : null}
                </span>
                <span
                  className="agent-directory-action"
                  data-state={exists ? "added" : busy ? "busy" : error ? "error" : undefined}
                >
                  {busy ? <LoaderCircle className="ic ic-xs spin" aria-hidden="true" /> : null}
                  {action ?? <ArrowRight className="ic ic-sm" aria-hidden="true" />}
                  {exists ? <Check className="ic ic-xs" aria-hidden="true" /> : null}
                </span>
              </button>
              {link && openExternal && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  type="button"
                  className="agent-directory-ext"
                  aria-label={t("agents.acp.about").replace("{name}", row.name)}
                  onClick={() => void openExternal(link)}
                >
                  <ExternalLink className="ic ic-xs" aria-hidden="true" />
                </Button>
              )}
              {error && (
                <p className="error-text" role="alert">
                  {error}
                </p>
              )}
            </div>
          )
        })}
      </div>
    )
  }
  return (
    <div className="agent-directory">
      <div className="agent-directory-search">
        <SearchField
          variant="plain"
          autoFocus
          inputRef={input}
          value={query}
          onValueChange={(value) => {
            onQuery(value)
            setHighlight(null)
          }}
          size="xl"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={active ? listId + active.key : undefined}
          onKeyDown={move}
          readOnly={pending}
          placeholder={t("agents.directory.search")}
          clearLabel={pending ? undefined : t("agents.directory.clear")}
        />
      </div>
      <div
        className="agent-directory-results"
        id={listId}
        role="listbox"
        aria-label={t("agents.list")}
      >
        {group(t("agents.directory.drivers"), native)}
        {group(t("agents.acp.registry"), remote)}
        {load && failed ? (
          <div className="agent-directory-notice" role="alert">
            <span>{t("agents.acp.failed")}</span>
            <Button size="sm" variant="ghost" onClick={() => setRetry((value) => value + 1)}>
              {t("agents.cli.retry")}
            </Button>
          </div>
        ) : load && !entries ? (
          <p className="agent-directory-notice" role="status">
            <LoaderCircle className="ic ic-xs spin" aria-hidden="true" />
            <span>{t("agents.acp.loading")}</span>
          </p>
        ) : (
          !native.length &&
          !remote.length && (
            <p className="agent-directory-notice">
              {t(query ? "agents.instance.noMatches" : "agents.instance.noAgents")}
            </p>
          )
        )}
      </div>
      <div className="agent-directory-foot">
        <div className="agent-directory-manual-actions">
          {local ? (
            <>
              <Button size="md" variant="ghost" disabled={pending} onClick={onLocal}>
                <Terminal className="ic ic-sm" aria-hidden="true" />
                {t("agents.acp.useLocal")}
              </Button>
              {load ? (
                <Button size="md" variant="ghost" disabled={pending} onClick={onManual}>
                  {t("agents.directory.byId")}
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
        <div className="agent-directory-hints" aria-hidden="true">
          <span>
            <kbd>↑↓</kbd>
            {t("agents.directory.hintMove")}
          </span>
          <span>
            <kbd>↵</kbd>
            {t("agents.directory.hintConfirm")}
          </span>
        </div>
      </div>
    </div>
  )
}
