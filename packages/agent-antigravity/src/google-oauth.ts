import { createInterface } from "node:readline"
import { ownProcessTree } from "@pigcode/plugin-sdk/node"
import { isolatedEnterpriseRedirect } from "./enterprise-auth"
import { spawnAgy, type AgyLaunch } from "./launch"

const callbackUrl = "https://antigravity.google/oauth-callback"

export type PresentAuthorization = (
  authorizationUrl: string,
  submit: (code: string) => void | Promise<void>,
) => void

export function googleAuthorization(line: string, isolatedBrowser = false): URL {
  const url = new URL(line)
  const redirect = URL.parse(url.searchParams.get("redirect_uri") ?? "")
  if (
    line.length > 16_384 ||
    url.origin !== "https://accounts.google.com" ||
    url.username ||
    url.password ||
    !["/o/oauth2/auth", "/o/oauth2/v2/auth"].includes(url.pathname) ||
    url.searchParams.get("response_type") !== "code" ||
    url.searchParams.getAll("redirect_uri").length !== 1 ||
    (!isolatedBrowser
      ? redirect?.href !== callbackUrl
      : !redirect || !isolatedEnterpriseRedirect(redirect)) ||
    url.searchParams.getAll("state").length !== 1 ||
    !url.searchParams.get("state")
  )
    throw new Error("Antigravity returned an invalid Google authorization link")
  return url
}

export function responseCode(response: string, authorization: string): string {
  const value = response.trim()
  if (/^[\w./~-]{1,2048}$/.test(value)) return value
  const url = URL.parse(value)
  const pending = new URL(authorization)
  const code = url?.searchParams.get("code")
  if (
    !url ||
    /[\r\n]/.test(value) ||
    url.username ||
    url.password ||
    url.origin + url.pathname !== pending.searchParams.get("redirect_uri") ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.get("state") !== pending.searchParams.get("state") ||
    url.searchParams.getAll("code").length !== 1 ||
    !code ||
    !/^[\w./~-]{1,2048}$/.test(code)
  )
    throw new Error("Paste the authorization code from this Google sign-in attempt")
  return code
}

export async function authenticateCli(
  launch: AgyLaunch,
  signal: AbortSignal,
  present: PresentAuthorization,
): Promise<void> {
  // agy 输出授权地址，用户从设置页打开系统浏览器。
  for (const key of Object.keys(launch.env)) {
    if (["DISPLAY", "WAYLAND_DISPLAY"].includes(key.toUpperCase())) delete launch.env[key]
  }
  signal.throwIfAborted()
  const child = spawnAgy(launch, ["--login"])
  const tree = ownProcessTree(child)
  const output = createInterface({ input: child.stdout })
  let submitted = false
  let abort = () => {}
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener("abort", abort, { once: true })
      child.once("error", () => reject(new Error("Could not start the Antigravity login process")))
      child.stdin.on("error", () =>
        reject(new Error("Antigravity could not receive the sign-in code")),
      )
      child.stderr.on("error", () => undefined)
      child.once("close", (code) => {
        if (code === 0 && submitted) resolve()
        else reject(new Error("Antigravity could not complete Google sign-in"))
      })
      output.on("line", (line) => {
        const candidate = line
          .trim()
          .replace(/^Open the following link to authenticate the ACP server:\s*/, "")
        if (!candidate.startsWith("https://accounts.google.com")) return
        try {
          present(candidate, (code) => {
            submitted = true
            child.stdin.end(code + "\n")
          })
        } catch (error) {
          reject(error)
        }
      })
    })
  } finally {
    signal.removeEventListener("abort", abort)
    output.close()
    await tree.terminate()
  }
}
