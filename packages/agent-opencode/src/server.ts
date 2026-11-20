import { randomBytes, createHash } from "node:crypto"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import {
  agentEnvironment,
  commonBinaryDirs,
  expandHome,
  findExecutable,
  launchTarget,
  ownProcessTree,
  PROCESS_TREE_SPAWN_OPTIONS,
} from "@pigcode/plugin-sdk/node"
import { settingEnvironment, settingString, type AgentSettingsValues } from "@pigcode/plugin-sdk"
import { record, untilAbort } from "@pigcode/native-agent-runtime"

export class OpenCodeHttpError extends Error {
  constructor(
    readonly status: number,
    route: string,
  ) {
    super(
      status === 401 || status === 403
        ? "OpenCode rejected the server credentials"
        : "OpenCode " + route + " returned HTTP " + status,
    )
  }
}

export class ServerApi {
  constructor(
    readonly url: string,
    readonly major: 1 | 2,
    readonly version: string,
    private readonly authorization: string | undefined,
    readonly lifetime: AbortSignal,
  ) {}
  private address(path: string, cwd?: string) {
    const url = new URL(this.url)
    url.pathname = url.pathname.replace(/\/$/, "") + path
    if (cwd) url.searchParams.set(this.major === 2 ? "location[directory]" : "directory", cwd)
    return url
  }
  async request(
    path: string,
    method: string,
    signal: AbortSignal,
    body?: unknown,
    cwd?: string,
    stream = false,
  ) {
    const response = await fetch(this.address(path, cwd), {
      method,
      signal: AbortSignal.any([signal, this.lifetime]),
      redirect: "error",
      headers: {
        accept: stream ? "text/event-stream" : "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.authorization ? { authorization: this.authorization } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new OpenCodeHttpError(response.status, path)
    }
    return response
  }
  async json(path: string, method: string, signal: AbortSignal, body?: unknown, cwd?: string) {
    const response = await this.request(path, method, signal, body, cwd)
    if (response.status === 204) return undefined
    const text = await response.text()
    if (!text.trim()) return undefined
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error("OpenCode did not return JSON for " + path)
    }
  }
}
function authorization(user: string, password?: string) {
  return password === undefined
    ? undefined
    : "Basic " + Buffer.from(user + ":" + password, "utf8").toString("base64")
}

async function probe(
  url: string,
  password: string | undefined,
  user: string,
  signal: AbortSignal,
  lifetime: AbortSignal,
) {
  for (const major of [2, 1] as const) {
    const route = major === 2 ? "/api/info" : "/global/health"
    const header = authorization(major === 2 ? "opencode" : user, password)
    const candidate = new ServerApi(url, major, "", header, lifetime)
    try {
      const info = record(await candidate.json(route, "GET", signal))
      if (
        typeof info.version === "string" &&
        (major === 2
          ? info.version.startsWith("2.") && typeof info.pid === "number"
          : info.healthy === true && info.version.startsWith("1."))
      )
        return new ServerApi(url, major, info.version, header, lifetime)
    } catch (error) {
      if (signal.aborted || lifetime.aborted || major === 1) throw error
      if (error instanceof OpenCodeHttpError && error.status === 401 && user === "opencode")
        throw error
    }
  }
  throw new Error("This address did not identify an OpenCode 1.x or 2.x server")
}

export function openCodeCli(settings: AgentSettingsValues) {
  const env = agentEnvironment(settingEnvironment(settings))
  const home = env.HOME || env.USERPROFILE || homedir()
  const selected = expandHome(settingString(settings, "binaryPath") ?? "opencode", home)
  const dirs = [join(home, ".opencode", "bin"), ...commonBinaryDirs(home)]
  const command =
    isAbsolute(selected) || /[\\/]/.test(selected)
      ? resolve(selected)
      : (findExecutable(selected, dirs, env.PATH) ?? selected)
  const target = launchTarget(command)
  if (target.shell) throw new Error("Select the OpenCode executable or an npm launcher")
  return { ...target, executable: command, env }
}

async function freePort() {
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === "string")
      throw new Error("Could not allocate a local OpenCode port")
    return address.port
  } finally {
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
  }
}
interface Lease {
  api: ServerApi
  release(): Promise<void>
}
interface Owned {
  executable: string
  stop: AbortController
  server: Promise<ServerApi>
  users: number
  close(): Promise<void>
  timer?: NodeJS.Timeout
}

export class OpenCodeServers {
  private readonly managed = new Map<string, Owned>()
  private readonly lifetime = new AbortController()
  async get(
    settings: AgentSettingsValues,
    cwd: string,
    signal: AbortSignal,
    instanceId?: string,
  ): Promise<Lease> {
    const url = settingString(settings, "serverUrl")
    const password = settingString(settings, "serverPassword")
    const env = agentEnvironment(settingEnvironment(settings))
    if (url) {
      const parsed = new URL(url)
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      )
        throw new Error(
          "Enter an HTTP(S) OpenCode server URL, and put its password in Server password",
        )
      const api = await probe(
        parsed.href,
        password,
        env.OPENCODE_SERVER_USERNAME || "opencode",
        AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
        this.lifetime.signal,
      )
      return { api, release: async () => {} }
    }
    const cli = openCodeCli(settings)
    const key = createHash("sha256")
      .update(JSON.stringify([instanceId, cli.command, cli.args, cli.env, password]))
      .digest("hex")
    let server = this.managed.get(key)
    if (!server || server.stop.signal.aborted) {
      const stop = new AbortController()
      let terminate = async () => {}
      const owner: Owned = {
        stop,
        users: 0,
        executable: cli.executable,
        server: (async () => {
          const port = await freePort()
          stop.signal.throwIfAborted()
          const secret = password ?? randomBytes(32).toString("base64url")
          const child = spawn(
            cli.command,
            [...cli.args, "serve", "--hostname=127.0.0.1", "--port=" + port],
            {
              ...PROCESS_TREE_SPAWN_OPTIONS,
              cwd,
              stdio: "ignore",
              env: {
                ...cli.env,
                OPENCODE_SERVER_USERNAME: "opencode",
                OPENCODE_SERVER_PASSWORD: secret,
                OPENCODE_PASSWORD: secret,
                OPENCODE_DISABLE_AUTOUPDATE: "1",
              },
            },
          )
          const tree = ownProcessTree(child)
          terminate = () => tree.terminate()
          child.once("error", () => stop.abort(new Error("OpenCode CLI failed to launch")))
          child.once("exit", () => stop.abort(new Error("The managed OpenCode server exited")))
          const startup = AbortSignal.any([stop.signal, AbortSignal.timeout(30_000)])
          while (!startup.aborted) {
            try {
              return await probe(
                "http://127.0.0.1:" + port,
                secret,
                "opencode",
                AbortSignal.any([startup, AbortSignal.timeout(1500)]),
                stop.signal,
              )
            } catch (error) {
              if (
                error instanceof OpenCodeHttpError &&
                (error.status === 401 || error.status === 403)
              )
                throw error
              await delay(150, undefined, { signal: startup })
            }
          }
          throw startup.reason
        })(),
        close: async () => {
          clearTimeout(owner.timer)
          if (this.managed.get(key) === owner) this.managed.delete(key)
          stop.abort()
          await terminate()
        },
      }
      this.managed.set(key, owner)
      void owner.server.catch(() => owner.close())
      server = owner
    }
    const owner = server
    clearTimeout(owner.timer)
    owner.users++
    let released = false
    const release = async () => {
      if (released) return
      released = true
      if (--owner.users === 0) {
        if (this.managed.get(key) !== owner) {
          await owner.close()
          return
        }
        owner.timer = setTimeout(() => void owner.close(), 8_000)
        owner.timer.unref()
      }
    }
    try {
      return { api: await untilAbort(owner.server, signal), release }
    } catch (error) {
      await release()
      throw error
    }
  }
  async updated(executable: string) {
    const retired: Promise<void>[] = []
    for (const [key, owner] of this.managed) {
      if (owner.executable !== executable) continue
      this.managed.delete(key)
      if (!owner.users) retired.push(owner.close())
    }
    await Promise.allSettled(retired)
  }
  async close() {
    this.lifetime.abort()
    await Promise.allSettled([...this.managed.values()].map((server) => server.close()))
  }
}
