# Pigcode Frontend

Pigcode 桌面端的 pnpm monorepo，包含 `apps/`（desktop、host）与 `packages/`（contracts、client-runtime、UI 包等）。

## Real Claude smoke

Set `PIGCODE_REAL_CLAUDE=1` and run:

```bash
pnpm real:claude
```

The test uses the installed and authenticated Claude Code CLI with a minimal
prompt. It never logs in and never reads credential files.
