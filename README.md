# Pigcode Frontend

Pigcode 桌面端的 pnpm monorepo，包含 `apps/`（desktop、host）与 `packages/`（contracts、client-runtime、UI 包等）。

## UI and shortcuts

- Window buttons are always the system's own. On macOS the native traffic lights sit in the
  sidebar's top row. On Windows and Linux the app draws a title bar with File, Edit, View, and
  Help (each opens a native menu), and the system minimize, maximize, and close buttons overlay
  it on whichever side the desktop puts them.
- Shortcut hints read `⌘` on macOS and `Ctrl` on Windows and Linux; the shortcuts below accept
  either modifier.
- Add project opens the create-project dialog. The source folder is chosen with the system file
  manager (Finder, Explorer, or the GTK chooser); a blank project name uses the folder name.
- `⌘K` opens the command palette for actions, thread switching, and projects.
- `⌘N` creates a new session; `⌘B` toggles the sidebar; `⌘J` toggles the workbench;
  `⌘,` opens settings.
- New sessions are automatically titled from the first user message.
- The workbench width is draggable; double-click the divider to reset it.
- Running, queued, waiting-approval, completed, failed, and interrupted states are shown
  on both tabs and the sidebar; a running thread shows an animated 3×3 dot matrix.
- The thread header's split button opens the project folder in the file manager, an
  installed editor (VS Code, Cursor, Windsurf, Trae, Zed, CodeBuddy, JetBrains…) or a
  terminal (Terminal, iTerm, Ghostty, Warp, Windows Terminal, GNOME Terminal…), with the
  app's own icon; the last choice becomes the default.

## Composer

- The model chip opens a picker with the enabled agents (Claude Code, Codex, installed
  agent plugins) on the left; only the selected agent's models are listed, followed by the
  custom models added in Settings → Agent. Search, `⌘1…9`, and stars for favorites work
  inside it; `⌘/` opens it from the input box.
- Thinking depth lists only the levels the current model supports (Codex
  `supportedReasoningEfforts`, Claude effort levels) and is remembered per model.
- Permissions: ask every time, plan mode, read only, and full access (asks for
  confirmation). `⇧Tab` cycles the first three; the choice is stored on the thread.
- `@` references a project file, `/` at the start of a line runs a command, `↑`/`↓` in
  an empty box bring back sent messages, and each thread keeps its own draft. The input
  is plain text: Markdown markers are sent as typed, and `⇧↵` adds a line break.

## Timeline

The conversation follows ZCode's history layout. Each run is one turn: the user's
message on the right (long messages fold, `@files` show as file chips), then the agent's
work under a "Working for…" header that folds into "Worked for N s" when the run ends,
leaving the final answer, a "N files changed" card and hover actions (copy, time).
The work stays open while running and when a run fails or is stopped.

- Every tool has its own row in ZCode's style: terminal (with `$ command` and live output),
  read, write/edit with an inline diff, search, web fetch, MCP (server · tool, result and
  call details), skill, background task output and stop, AskUserQuestion, the plan card
  from plan mode, browser steps, sub-agents (opened in a tab) and a fallback for anything
  else. Running rows shimmer; failures show "Failed" with the reason and exit code on hover.
- Two or more lookups in a row fold into "Explore · 3 files, 2 searches"; two or more
  commands into "Terminal · N commands, M failed"; browser steps into one browser row.
- Thinking shows as "Thinking" while streaming and "Thought · for N seconds" afterwards.
- Todos stay out of the stream and appear in the floating status panel (capsule or panel),
  together with running commands and sub-agents. A rail on the left jumps between questions.
- Answers render Markdown with tables, task lists, nested lists, images and code blocks
  (language, wrap and copy, highlighted with Shiki). Pending approvals and questions stay
  visible below the work.

## Development

```bash
pnpm dev
```

starts the desktop app with live reload:

- Renderer code is served by the Vite dev server: components update in place, other modules
  reload the page, and the page reconnects to the Host on its own.
- Host code (`apps/host`, the built-in agent plugins and the packages they use) is rebuilt by
  `scripts/build-host.ts --watch`; after a successful rebuild the main process restarts the Host
  without closing the window. Running agents and terminals end with the old Host. A failed rebuild
  keeps the running Host.
- Main process and preload changes rebuild too; electron-vite restarts Electron for the main
  process and reloads the page for the preload.

Arguments go to `electron-vite dev`, and anything after `--` goes to Electron:
`pnpm dev --remoteDebuggingPort 9222 --inspect 9229 -- --user-data-dir=/tmp/pigcode-dev`.
`pnpm dev` uses the default profile, so quit any other Pigcode on that profile first, or set
`PIGCODE_PROFILE_DIR`. The quit confirmation is off in this mode (`PIGCODE_QUIT_CONFIRM=1` turns it
back on) because restarting Electron goes through the normal quit flow.

## TypeScript

Everything is TypeScript, including scripts and configs. Scripts run with Node's built-in
type stripping (Node 22.18 or newer), for example `pnpm build:host` or
`node scripts/create-plugin.ts`. Plugins can point `main`, `pigcode.host`, and
`pigcode.client` at `.ts` / `.tsx` files; the Host transpiles `.tsx` on install, so a React
UI plugin runs straight from source. See [docs/plugin-authoring.md](docs/plugin-authoring.md).

## Workbench

The right panel provides files, per-run diffs, an embedded PTY terminal, checkpoints,
and git worktrees. Checkpoints are stored under
`refs/pigcode/checkpoints/<thread>/<run>/<phase>` and never add commits to your branch.
Files, git, the terminal and PR creation all follow the thread's worktree: its own, then
the parent thread's, then the project folder.

Open the Files surface from the right panel or use Browse files on a project in the sidebar.
The layout follows ZCode, with a shared toolbar above the directory and preview.

- The tree loads folders lazily, dims git-ignored entries, and marks changed files with
  their git status. Opening a folder whose only child is a folder opens the whole chain as
  one row (`main/java/com/example`). Typing in the filter searches every path in the
  worktree.
- Arrow keys move and expand, and `↵` previews. The toolbar can show only files with Git
  changes. The context menu can open a file in an external editor, save a copy, mention it in
  the composer, copy its absolute or relative path, or reveal it in the file manager.
  Dragging a row onto the composer mentions it as well.
- A click reuses the preview tab. Use `⌘`/`Ctrl`-click or the context menu to open a separate
  tab. Editing keeps the tab open. Text files are editable with theme-aware Shiki highlighting.
  `⌘S` saves, a dot marks unsaved tabs, and closing one asks first; so does
  closing, quitting or reloading the window while any file is unsaved. If the file changed
  on disk since it was opened, saving stops and offers to reload or overwrite.
  Files over 1 MB open read-only with the first 1 MB shown. Images show a preview, and Markdown
  can switch between a rendered preview and editable source.
- Drag the divider to resize the directory, or collapse it from the toolbar. A narrow panel
  switches between the directory and preview.
  The tree refreshes after agent runs, saves, checkpoint restores and worktree changes.

After a clean install, rebuild the native PTY helper for Electron before running the
workbench E2E:

```bash
pnpm --dir apps/desktop rebuild:native
```

## Multi-session and ecosystem

Threads open in tabs and keep running in the background when you switch away. Runs beyond
the concurrency limit enter a FIFO queue (`run.list` / `run.queued`), and every tab shows
its own queued, running, waiting-approval, completed, failed, or interrupted state.

M5 also adds subagent timelines, thread-scoped MCP tools from Capability plugins, GitHub
PR creation through the `gh` CLI, loopback-only browser previews, and interval schedules
persisted in SQLite. See [docs/m5-ecosystem.md](docs/m5-ecosystem.md) for commands,
limits, and prerequisites.

## Agents and plugins

Plugins are ordinary npm packages with a `pigcode` manifest field. Agent, Capability,
and UI plugins load and unload without restarting the app.

Every agent is a plugin. Claude Code and Codex ship with the app as built-in plugins:
they can be disabled but not uninstalled. Install and uninstall third-party Agent plugins
from the Plugins page in the sidebar.

Settings → Agent shows each agent's status (installed, version, signed in), the Agent
features it supports, and the settings its plugin declares. The built-in agents have the same
settings as t3code: binary path, `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, launch arguments,
and environment variables, plus custom model ids that appear in the composer's picker.
Changes apply to the next run; running sessions are not interrupted. The page also picks
the default agent for new sessions; Automatic uses the first agent that is installed and
signed in.

The Plugins page sits next to New chat in the sidebar and keeps the workspace sidebar. It
groups plugins by kind into two columns of cards: a switch per plugin, Open for plugins
with a settings page, and their package, kind, permissions and conflicts in the details
dialog. UI plugins draw inside host chrome:
sidebar panels get the sidebar's group header, right-panel surfaces open as regular tabs
from the launcher, and plugins build their UI with the host's own React and
`@pigcode/ui-primitives`, so buttons, rows, settings groups and switches look exactly like
the host's and follow its theme and language.

See [docs/plugin-authoring.md](docs/plugin-authoring.md) for writing agent and other
plugins.

## Profile and data

The app ships a read-only core profile (`apps/desktop/out/host/profile/desktop.yml`,
written by `pnpm build:host`) listing the Host services and built-in plugins. Everything
you change lives in the user profile directory, by default `profiles/desktop` under
Electron's `userData`:

| File            | Contents                                               |
| --------------- | ------------------------------------------------------ |
| `plugins.yml`   | Installed plugins and which plugins are disabled       |
| `node_modules`  | Installed plugin packages                              |
| `settings.json` | Agent settings, custom models and the default agent    |
| `pigcode.db`    | Projects, threads, events, runs and schedules (SQLite) |
| `boot.json`     | UI plugin boot graph, rewritten on every change        |

Environment overrides:

- `PIGCODE_PROFILE_DIR`: use another user profile directory.
- `PIGCODE_DB_PATH`: use another database file, or `:memory:` for a throwaway one.
- `PIGCODE_CORE_PROFILE_DIR`: load the core profile from another directory.
- `PIGCODE_AGENT`: force the default agent (`claude`, `codex`, or `fake` for the
  scripted development agent, which is otherwise not registered).
- `PIGCODE_CLAUDE_PATH`: Claude Code executable used when its binary path setting is blank.
- `PIGCODE_CODEX_PATH`: Codex executable used when its binary path setting is blank.

The E2E suite runs with `PIGCODE_PROFILE_DIR=apps/desktop/out-e2e/profile` (cleared
before each run) and an in-memory database.

Visual baselines in `apps/desktop/visual/__screenshots__` are generated on the CI
runner image (`ubuntu-24.04`) with `fonts-noto-cjk` installed; other systems render
fonts differently, so the visual specs only pass there. After an intended UI change, run
`gh workflow run visual-baselines.yml --ref <branch>`; it regenerates the screenshots
and commits them to that branch.

## Real Claude smoke

Set `PIGCODE_REAL_CLAUDE=1` and run:

```bash
pnpm real:claude
```

The test uses the installed and authenticated Claude Code CLI with a minimal
prompt. It never logs in and never reads credential files.

If the CLI's default model does not exist on your proxy or gateway, pick one it has:

```bash
PIGCODE_REAL_CLAUDE=1 PIGCODE_CLAUDE_MODEL=<model> pnpm real:claude
```

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

## Real MCP tools

Checks that each real CLI can list and call a plugin MCP tool. The tool returns a random
secret, so an answer containing it proves the model actually called the tool. Set the flag
for each agent you want to run:

```bash
PIGCODE_REAL_CLAUDE=1 PIGCODE_REAL_CODEX=1 pnpm real:mcp
```

If the Claude CLI's default model is not on your proxy or gateway, add
`PIGCODE_CLAUDE_MODEL=<model>`.
