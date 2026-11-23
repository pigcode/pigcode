import { app } from "electron"
import { join } from "node:path"

export function resolveAppPath(...segments: string[]): string {
  return join(app.getAppPath(), ...segments)
}

export function profileDir(): string {
  return process.env.PIGCODE_PROFILE_DIR ?? join(app.getPath("userData"), "profiles", "desktop")
}

export function preferencesPath(): string {
  return join(profileDir(), "preferences.json")
}
