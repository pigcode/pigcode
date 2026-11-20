import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import type { AgentEvent } from "@pigcode/contracts"
import { PiDriver } from "../src/driver"

const peer = String.raw`
#!/usr/bin/env node
import {appendFileSync,existsSync,writeFileSync} from "node:fs"
import {join} from "node:path"
import {createInterface} from "node:readline"
const args=process.argv.slice(2),root=process.env.PI_TEST_ROOT
if(args[0]==="--version"){console.log("1.6.0");process.exit(0)}
const sessionFile= args.includes("--session")?args[args.indexOf("--session")+1]:join(root,"session.jsonl")
const log=v=>appendFileSync(join(root,"events"),JSON.stringify(v)+"\n")
log({args})
const send=v=>console.log(JSON.stringify(v))
if(args.includes("--extension")){
  const {pathToFileURL}=await import("node:url")
  const hooks={}
  const api={on:(name,fn)=>hooks[name]=fn,registerMcpServer:(name,server)=>log({mcp:name,command:server.command}),getAllTools:()=>[]}
  await (await import(pathToFileURL(args[args.indexOf("--extension")+1]).href)).default(api)
  const ctx={ui:{notify:message=>send({type:"extension_ui_request",method:"notify",id:"ready",message}),
    confirm:(title,message)=>{send({type:"extension_ui_request",id:"approve",method:"confirm",title,message});return new Promise(resolve=>globalThis.confirmTool=resolve)}}}
  await hooks.session_start({},ctx)
  globalThis.tool=()=>hooks.tool_call({toolName:"bash",input:{command:"echo test"}},ctx)
}
const model={id:"one",name:"One",provider:"test",reasoning:true,thinkingLevelMap:{xhigh:null}}
createInterface({input:process.stdin}).on("line",async line=>{
  const {id,type,...params}=JSON.parse(line)
  log({type,...params})
  const ok=data=>send({id,type:"response",command:type,success:true,data})
  if(type==="get_state")return ok({model,thinkingLevel:"medium",sessionFile})
  if(type==="get_commands")return ok({commands:[{name:"summarize",source:"prompt",description:"Summary"}]})
  if(type==="get_available_models")return ok({models:[model]})
  if(type==="get_session_stats")return ok({contextUsage:{tokens:42,contextWindow:1000}})
  if(type==="extension_ui_response"){globalThis.confirmTool(params.confirmed);return}
  if(type==="abort"){ok({});send({type:"agent_settled",aborted:true});return}
  if(type!=="prompt")return ok({})
  ok({disposition:"started"})
  if(params.message==="wait")return
  writeFileSync(sessionFile,"{}\n")
  const decision=await globalThis.tool()
  log({blocked:decision?.block===true})
  send({type:"message_update",assistantMessageEvent:{type:"text_delta",contentIndex:0,delta:"stream\u2028text"}})
  send({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"stream\u2028text"}],stopReason:"stop",usage:{input:2}}})
  send({type:"agent_end",willRetry:false,messages:[]})
  send({type:"agent_settled",aborted:false})
})
`.trimStart()

it("uses native RPC args, genuine tool approval hooks, model selection, session files, and cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pigcode-pi-test-"))
  const executable = join(root, "peer.mjs")
  await writeFile(executable, peer, { mode: 0o700 })
  const bin = process.platform === "win32" ? join(root, "peer.cmd") : executable
  if (bin !== executable) await writeFile(bin, '@SETLOCAL\r\nnode "%~dp0peer.mjs" %*\r\n')
  const settings = {
    binaryPath: bin,
    launchArgs: '--name "Two words"',
    environment: [{ name: "PI_TEST_ROOT", value: root }],
  }
  const driver = new PiDriver()
  try {
    expect(await driver.detect(settings)).toMatchObject({ installed: true, version: "1.6.0" })
    expect(await driver.listModels(settings)).toMatchObject([
      { id: "test/one", displayName: "One", isDefault: true },
    ])
    expect(await driver.listCommands(settings, root)).toMatchObject([
      { name: "summarize", text: "/summarize" },
    ])
    const input = {
      cwd: root,
      threadId: "t",
      permissionMode: "approval-required",
      settings,
      model: "test/one",
    }
    const handle = await driver.createSession(input)
    const events: AgentEvent[] = []
    const requestApproval = vi.fn(async () => "deny" as const)
    await driver.send(
      handle,
      { text: "hello", effort: "high" },
      { signal: new AbortController().signal, emit: (e) => events.push(e), requestApproval },
    )
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ toolName: "bash" }))
    expect(events).toContainEqual({ type: "message.delta", text: "stream\u2028text" })
    expect(events).toContainEqual({ type: "message.completed", text: "stream\u2028text" })
    const next = await driver.createSession({
      ...input,
      sessionId: handle.id,
      nativeSessionId: handle.nativeSessionId,
    })
    expect(next.nativeSessionId).toBe(handle.nativeSessionId)
    const controller = new AbortController()
    const run = driver.send(
      next,
      { text: "wait" },
      { signal: controller.signal, emit: (e) => events.push(e), requestApproval },
    )
    await expect.poll(() => readFile(join(root, "events"), "utf8")).toContain('"message":"wait"')
    controller.abort()
    await run
    expect(events).toContainEqual({ type: "run.interrupted" })
    const calls = (await readFile(join(root, "events"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(calls).toContainEqual({ type: "set_thinking_level", level: "high" })
    expect(calls).toContainEqual({ type: "set_model", provider: "test", modelId: "one" })
    expect(calls).toContainEqual({ blocked: true })
    expect(calls).toContainEqual({
      args: expect.arrayContaining([
        "--mode",
        "rpc",
        "--name",
        "Two words",
        "--session",
        join(root, "session.jsonl"),
      ]),
    })
  } finally {
    await driver.close()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
