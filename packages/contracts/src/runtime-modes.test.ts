import { expect, it } from "vitest"
import { DEFAULT_RUNTIME_MODE, normalizeRuntimeMode, legacyPermissionMode } from "./runtime-modes"
import { RUNTIME_MODE_OPTIONS } from "./runtime-mode-options"

it("defines the same four options and full-access default for every agent", () => {
  expect(RUNTIME_MODE_OPTIONS.map((mode) => mode.id)).toEqual([
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
  ])
  expect(DEFAULT_RUNTIME_MODE).toBe("full-access")
})

it("migrates existing permissions by their actual native meaning", () => {
  expect(normalizeRuntimeMode("workspace-write", "codex")).toBe("auto-accept-edits")
  expect(normalizeRuntimeMode("workspace-write", "claude")).toBe("approval-required")
  expect(normalizeRuntimeMode("read-only", "codex")).toBe("approval-required")
  expect(normalizeRuntimeMode("accept-edits", "claude")).toBe("auto-accept-edits")
  expect(normalizeRuntimeMode("dontAsk", "claude")).toBe("approval-required")
  expect(normalizeRuntimeMode("danger-full-access")).toBe("full-access")
  expect(normalizeRuntimeMode("unknown")).toBeNull()
})

it("uses supervision rather than automatic approvals for a legacy plugin", () => {
  expect(legacyPermissionMode("auto")).toBe("read-only")
  expect(legacyPermissionMode("approval-required")).toBe("read-only")
  expect(legacyPermissionMode("auto-accept-edits")).toBe("workspace-write")
  expect(legacyPermissionMode("full-access")).toBe("danger-full-access")
})
