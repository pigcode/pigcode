# Pigcode Frontend

Pigcode 桌面端的 pnpm monorepo，包含 `apps/`（desktop、host）与 `packages/`（contracts、client-runtime、UI 包等）。

## Workbench

The right panel provides files, per-run diffs, an embedded PTY terminal, checkpoints,
and git worktrees. Checkpoints are stored under
`refs/pigcode/checkpoints/<thread>/<run>/<phase>` and never add commits to your branch.

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
