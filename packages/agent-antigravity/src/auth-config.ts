import { createHash } from "node:crypto"
import { settingString, type AgentSettingsValues } from "@pigcode/plugin-sdk"

export const rejectedCredential =
  "Google rejected these Antigravity credentials. Check the key or the Application Default Credentials for this instance."
const labels = {
  "oauth-personal": "Google",
  "oauth-business": "Gemini Enterprise",
  "gemini-api-key": "Gemini API key",
  "agent-platform": "Vertex AI",
}
export function authConfig(values: AgentSettingsValues) {
  const raw = settingString(values, "authMethod") ?? "oauth-personal"
  if (!Object.hasOwn(labels, raw)) throw new Error("Unsupported Antigravity sign-in method")
  const method = raw as keyof typeof labels
  const key = settingString(values, "apiKey")
  const project = settingString(values, "gcpProject")
  const location = settingString(values, "gcpLocation")
  const browser = method === "oauth-personal" || method === "oauth-business"
  let error: string | null = null
  if (method === "oauth-business" && !(project && location))
    error = "Gemini Enterprise requires a GCP project and location"
  if (method === "gemini-api-key" && !key) error = "Set a Gemini API key in the instance settings"
  if (method === "agent-platform" && !key && !(project && location))
    error = "Vertex AI requires an API key or a GCP project and location"
  const gcp =
    method === "oauth-business" || method === "agent-platform"
      ? { ...(project ? { project } : {}), ...(location ? { location } : {}) }
      : {}
  const digest = (parts: unknown[]) =>
    createHash("sha256").update(JSON.stringify(parts)).digest("hex")
  return {
    method,
    browser,
    key,
    gcp,
    error,
    label: labels[method],
    profileKey: method === "oauth-personal" ? "" : digest([method, gcp]),
    credentialKey: digest([method, gcp, browser ? "" : key, values.binaryPath, values.environment]),
  }
}
