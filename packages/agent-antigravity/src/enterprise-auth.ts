import { get } from "node:http"
import { openAcp, requestOptions } from "./connection"
import type { AgyLaunch } from "./launch"

// 独立 ACP 运行时使用 BROWSER，并把凭据保存在选定的实例目录。
const marker = "__PIGCODE_ANTIGRAVITY_AUTH__"
export const enterpriseRuntimeRequired =
  "Gemini Enterprise requires the official standalone Antigravity ACP executable and its matching harness for isolated browser sign-in. Select that executable or use Vertex AI with Application Default Credentials."

export function isolatedEnterpriseRedirect(redirect: URL): boolean {
  return (
    redirect.protocol === "http:" &&
    redirect.hostname === "127.0.0.1" &&
    Number(redirect.port) >= 1024 &&
    (redirect.pathname === "/" || redirect.pathname === "/auth/callback") &&
    !redirect.username &&
    !redirect.password &&
    !redirect.hash &&
    !redirect.search
  )
}

/** OAuth 回调只发给独立 ACP 进程的回环端口，无代理或重定向。 */
async function forwardCallback(target: URL, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = get(
      target,
      { agent: false, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) },
      (reply) => {
        reply.resume()
        const status = reply.statusCode ?? 0
        if (status >= 200 && status < 400) resolve()
        else reject(new Error("Antigravity rejected the Enterprise sign-in response"))
      },
    )
    request.once("error", () =>
      reject(new Error("Could not reach the Antigravity sign-in callback")),
    )
  })
}

export async function authenticateBrowser(
  launch: AgyLaunch,
  methodId: "oauth-business" | "oauth-personal",
  signal: AbortSignal,
  present: (authorizationUrl: string, submit: (code: string) => Promise<void>) => void,
): Promise<void> {
  if (!launch.env.ANTIGRAVITY_HARNESS_PATH) throw new Error(enterpriseRuntimeRequired)
  const capture = `process.stderr.write(${JSON.stringify(marker)}+JSON.stringify(process.argv[1])+"\\n")`
  const executable =
    process.platform === "win32" ? process.execPath.replaceAll("\\", "/") : process.execPath
  const quote = (argument: string) => "'" + argument.replaceAll("'", "'\"'\"'") + "'"
  if (
    /[\r\n\0]|%s/.test(executable) ||
    executable.includes(process.platform === "win32" ? ";" : ":")
  )
    throw new Error("The Antigravity browser helper could not use this Pigcode installation path")
  const env = {
    ...launch.env,
    BROWSER: [executable, "-e", capture, "--", "%s"].map(quote).join(" "),
    ELECTRON_RUN_AS_NODE: "1",
  }
  const rejected = new AbortController()
  const waiting = AbortSignal.any([signal, rejected.signal])
  let published: string | undefined
  const rpc = openAcp({ ...launch, env }, (line) => {
    if (!line.startsWith(marker) || waiting.aborted) return
    try {
      const raw = line.slice(marker.length)
      if (raw.length > 16_384)
        throw new Error("Antigravity returned an invalid Enterprise sign-in URL")
      const link: unknown = JSON.parse(raw)
      if (typeof link !== "string")
        throw new Error("Antigravity returned an invalid Enterprise sign-in URL")
      if (link === published) return
      const url = new URL(link)
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "")
      const state = url.searchParams.get("state")
      if (!state || !isolatedEnterpriseRedirect(redirect))
        throw new Error("Antigravity returned an invalid Enterprise callback URL")
      present(link, (code) => {
        const target = new URL(redirect)
        target.searchParams.set("state", state)
        target.searchParams.set("code", code)
        return forwardCallback(target, waiting)
      })
      published = link
    } catch (error) {
      rejected.abort(error)
    }
  })
  try {
    const info = await rpc.initialize(waiting)
    if (!info.authMethods?.some(({ id }) => id === methodId))
      throw new Error(
        "This standalone Antigravity ACP release does not offer the selected Google sign-in method",
      )
    await rpc.agent.request("authenticate", { methodId }, requestOptions(waiting, 5 * 60_000))
  } catch (error) {
    if (rejected.signal.aborted) throw rejected.signal.reason
    throw error
  } finally {
    await rpc.close()
  }
}
