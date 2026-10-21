# Pigcode Frontend

Pigcode 桌面端的 pnpm monorepo，包含 `apps/`（desktop、host）与 `packages/`（contracts、client-runtime、UI 包等）。

## UI and shortcuts

- `⌘K` opens the command palette for actions, thread switching, and projects.
- `⌘N` creates a new session; `⌘B` toggles the sidebar; `⌘J` toggles the workbench;
  `⌘,` opens settings.
- New sessions are automatically titled from the first user message.
- The workbench width is draggable; double-click the divider to reset it.
- Running, queued, waiting-approval, completed, failed, and interrupted states are shown
  on both tabs and the sidebar.

## Workbench

The right panel provides files, per-run diffs, an embedded PTY terminal, checkpoints,
and git worktrees. Checkpoints are stored under
`refs/pigcode/checkpoints/<thread>/<run>/<phase>` and never add commits to your branch.

After a clean install, rebuild the native PTY helper for Electron before running the
workbench E2E:

```bash
pnpm --dir apps/desktop rebuild:native
```

## Multi-session and ecosystem

Threads open in tabs and keep running in the background when you switch away. Runs beyond
the concurrency limit enter a FIFO queue (`run.list` / `run.queued`), and every tab shows
its own queued, running, waiting-approval, completed, failed, or interrupted state.

M5 also adds subagent timelines, thread-scoped MCP tools from capability plugins, GitHub
PR creation through the `gh` CLI, loopback-only browser previews, and interval schedules
persisted in SQLite. See [docs/m5-ecosystem.md](docs/m5-ecosystem.md) for commands,
limits, and prerequisites.

## Plugins

Plugins are ordinary npm packages with a `pigcode` manifest field. Install a local
directory or npm spec from Settings → Plugins. Provider, capability, and UI plugins
load and unload without restarting the app.

See [docs/plugin-authoring.md](docs/plugin-authoring.md).

## Real Claude smoke

Set `PIGCODE_REAL_CLAUDE=1` and run:

```bash
pnpm real:claude
```

The test uses the installed and authenticated Claude Code CLI with a minimal
prompt. It never logs in and never reads credential files.

## Real Codex smoke

Set `PIGCODE_REAL_CODEX=1` and run:

```bash
pnpm real:codex
```

The test uses the installed and authenticated Codex CLI with a minimal prompt.
It never logs in and never reads credential files.

If the default model is at capacity, override it:

```bash
PIGCODE_REAL_CODEX=1 PIGCODE_CODEX_MODEL=gpt-6-astra pnpm real:codex
```

## Real Codex multi-session

The M5 acceptance test runs two real Codex threads in parallel and expects `OK-1` and
`OK-2`. It defaults to `gpt-6.1-sol`:

```bash
PIGCODE_REAL_CODEX=1 PIGCODE_CODEX_MODEL=gpt-6.1-sol pnpm real:codex:multi
```

It is skipped unless `PIGCODE_REAL_CODEX=1`, so it never consumes quota by default.
