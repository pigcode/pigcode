import { useEffect, useState } from "react"
import { Badge, Button, EmptyState, ListRow, useLocale } from "@pigcode/ui-primitives"
import type { Project } from "@pigcode/contracts"
import type { ClientPluginContext } from "@pigcode/plugin-sdk"

interface GitStatus {
  branch: string | null
  changed: { path: string; status: string }[]
}

const copy = {
  "zh-CN": {
    title: "项目概览",
    pick: "选择项目",
    loading: "正在读取项目…",
    empty: "还没有项目",
    refresh: "刷新",
    folder: "项目目录",
    branch: "Git 分支",
    detached: "分离的 HEAD",
    noChanges: "工作区干净",
    changes: (count: number) => `${count} 个变更文件`,
  },
  "en-US": {
    title: "Project Overview",
    pick: "Choose a project",
    loading: "Loading projects…",
    empty: "No projects yet",
    refresh: "Refresh",
    folder: "Project folder",
    branch: "Git branch",
    detached: "Detached HEAD",
    noChanges: "Working tree is clean",
    changes: (count: number) => `${count} changed ${count === 1 ? "file" : "files"}`,
  },
}

function ProjectOverview({ host }: { host: ClientPluginContext["host"] }) {
  const { locale } = useLocale()
  const t = copy[locale]
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [selected, select] = useState("")
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [projectError, setProjectError] = useState("")
  const [gitError, setGitError] = useState("")
  const [refreshCount, setRefreshCount] = useState(0)
  const project = projects?.find(({ id }) => id === selected) ?? projects?.[0]
  const projectId = project?.id

  useEffect(() => {
    let active = true
    setProjectError("")
    void host.call("project.list", {}).then(
      (result) => {
        if (active) setProjects(result as Project[])
      },
      (error: unknown) => {
        if (active) setProjectError(String(error))
      },
    )
    return () => {
      active = false
    }
  }, [host, refreshCount])

  useEffect(() => {
    setStatus(null)
    setGitError("")
    if (!projectId) return
    let active = true
    void host.call("git.status", { projectId }).then(
      (result) => {
        if (active) setStatus(result as GitStatus)
      },
      (error: unknown) => {
        if (active) setGitError(String(error))
      },
    )
    return () => {
      active = false
    }
  }, [host, projectId, refreshCount])

  return (
    <>
      <div className="row">
        <select
          className="input grow"
          aria-label={t.pick}
          value={projectId ?? ""}
          onChange={(event) => select(event.target.value)}
        >
          {projects?.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <Button size="sm" onClick={() => setRefreshCount((count) => count + 1)}>
          {t.refresh}
        </Button>
      </div>
      {projectError ? (
        <p className="error-text" role="alert">
          {projectError}
        </p>
      ) : null}
      {!project && !projectError ? (
        <EmptyState size="compact" title={projects ? t.empty : t.loading} />
      ) : null}
      {project ? <ListRow title={t.folder} description={project.rootPath} /> : null}
      {gitError ? (
        <p className="hint" role="status">
          {gitError}
        </p>
      ) : null}
      {status ? (
        <>
          <ListRow title={t.branch} meta={<Badge>{status.branch ?? t.detached}</Badge>} />
          <p className="hint">
            {status.changed.length ? t.changes(status.changed.length) : t.noChanges}
          </p>
          {status.changed.map((change) => (
            <ListRow
              key={change.path}
              density="compact"
              title={change.path}
              meta={<Badge>{change.status.trim()}</Badge>}
            />
          ))}
        </>
      ) : null}
    </>
  )
}

export function apply(ctx: ClientPluginContext): () => void {
  const title = copy[ctx.locale.get() === "zh-CN" ? "zh-CN" : "en-US"].title
  return ctx.surfaces.register({
    id: "pigcode.project-overview",
    title,
    Component: () => <ProjectOverview host={ctx.host} />,
  })
}
