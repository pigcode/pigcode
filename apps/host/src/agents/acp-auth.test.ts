import { Context } from "cordis"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { AcpDriver } from "../../../../packages/agent-acp/src/driver"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as terminal } from "../services/terminal"
import { apply as threads } from "../services/threads"
import { apply as agents } from "./registry"

const peer = String.raw`
import { createInterface } from "node:readline"
import { existsSync, writeFileSync, appendFileSync } from "node:fs"
const args = process.argv.slice(2)
const marker = process.env.PIG_TEST_AUTH
if (args.includes("--login")) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || args.join("|") !== "acp|two words|--login" ||
      process.env.PIG_TEST_METHOD !== "method override" || process.env.PIG_TEST_INSTANCE !== "selected")
    process.exit(3)
  process.stdin.setRawMode(true)
  process.stdout.write("Authorize fixture")
  process.stdin.on("data", data => {
    if (data.toString() === "y") writeFileSync(marker,"yes")
    process.exit(data.toString() === "f" ? 1 : 0)
  })
} else {
  const send = msg => console.log(JSON.stringify({jsonrpc:"2.0", ...msg}))
  createInterface({input:process.stdin}).on("line", line => {
    const {id,method,params} = JSON.parse(line)
    const result = result => send({id,result})
    if(method === "initialize") return result({protocolVersion:1,agentCapabilities:{},authMethods:
      params.clientCapabilities?.auth?.terminal ? [{id:"interactive",name:"Interactive",type:"terminal",args:["--login"],env:{PIG_TEST_METHOD:"method override"}}] : []})
    if(method === "session/new") {
      appendFileSync(marker + ".checks",String(process.pid)+"\n")
      if(existsSync(marker)) return result({sessionId:"fixture-session"})
      return send({id,error:{code:-32000,message:"Authentication required"}})
    }
    send({id,error:{code:-32601,message:"Method not found"}})
  })
}`

it("runs the advertised login command in a PTY and verifies credentials on a fresh ACP connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pigcode-auth-pty-"))
  const file = join(directory, "peer.mjs")
  const marker = join(directory, "connected")
  await writeFile(file, peer)
  const driver = new AcpDriver()
  const ctx = new Context()
  try {
    await ctx.plugin(storage, { path: ":memory:" })
    await ctx.plugin(settings, {})
    await ctx.plugin(projects)
    await ctx.plugin(threads)
    await ctx.plugin(sessions)
    await ctx.plugin(agents, { fake: false, dataDir: join(directory, "data") })
    await ctx.plugin(terminal, {})
    ctx.agents.register(driver)
    const instance = ctx.agents.createInstance("acp", "Login fixture", {
      values: {
        binaryPath: process.execPath,
        arguments: [file, "acp", "two words"],
        environment: [
          { name: "PIG_TEST_AUTH", value: marker },
          { name: "PIG_TEST_INSTANCE", value: "selected" },
          { name: "PIG_TEST_METHOD", value: "base" },
        ],
      },
    })
    const id = instance.instanceId
    const status = () => ctx.agents.auth(id, { action: "status" })
    expect(await ctx.agents.auth(id, { action: "status", refresh: true })).toMatchObject({
      phase: "signed-out",
      methods: [{ id: "interactive", name: "Interactive" }],
    })
    async function start() {
      const login = await ctx.agents.auth(id, { action: "start", methodId: "interactive" })
      await expect
        .poll(async () => (await status()).terminal?.output, { timeout: 6500 })
        .toContain("Authorize fixture")
      return login.flowId!
    }
    const cancelled = await start()
    await expect(
      ctx.agents.auth(id, { action: "cancel", flowId: cancelled }),
    ).resolves.toMatchObject({ phase: "cancelled" })
    const unverified = await start()
    await expect(
      ctx.agents.auth(id, { action: "terminal", flowId: cancelled, data: "y" }),
    ).rejects.toThrow()
    await ctx.agents.auth(id, { action: "terminal", flowId: unverified, data: "n" })
    await expect.poll(async () => (await status()).phase).toBe("failed")
    const accepted = await start()
    await ctx.agents.auth(id, {
      action: "terminal",
      flowId: accepted,
      size: { cols: 72, rows: 12 },
    })
    await ctx.agents.auth(id, { action: "terminal", flowId: accepted, data: "y" })
    await expect.poll(async () => (await status()).phase).toBe("connected")
    const probes = (await readFile(marker + ".checks", "utf8")).trim().split("\n")
    expect(new Set(probes).size).toBeGreaterThanOrEqual(3)
    expect((await status()).terminal).toBeUndefined()
  } finally {
    await driver.close()
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}, 25_000)
