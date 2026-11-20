import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { grok } from "../../agent-grok/src/driver"
import { fx } from "../../agent-fx/src/driver"
import { kiro } from "../../agent-kiro/src/driver"
import { NativeAcpDriver } from "../src/native-cli"
import type { AgentEvent } from "@pigcode/contracts"

const peer = String.raw`
#!/usr/bin/env node
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"
const args = process.argv.slice(2)
const id = process.env.TEST_ID, log = process.env.TEST_LOG
const record = value => appendFileSync(log,JSON.stringify(value)+"\n")
const send = value => console.log(JSON.stringify({jsonrpc:"2.0",...value}))
record({args,key:process.env.KIRO_API_KEY})
if (args[0] === "--version") { console.log(id+" 2.0.0"); process.exit(0) }
if (args[0] === "models") {console.log(id==="fx"?JSON.stringify({ids:["one","two"]}):"You are logged in\n- one (default)\n- two");process.exit(0)}
if (args[0] === "status") {console.log(JSON.stringify({auth:"browser",model:"one"}));process.exit(0)}
if (args[0] === "whoami") {console.log(JSON.stringify({accountType:"ApiKey"}));process.exit(0)}
if (args[0] === "chat") {console.log(JSON.stringify({default_model:"one",models:[{model_id:"one"},{model_id:"two"}]}));process.exit(0)}
const grokMetadata={modelState:{currentModelId:"one",availableModels:[{modelId:"two",name:"Native Two",_meta:{reasoningEffort:"high",reasoningEfforts:[{id:"high"},{value:"low"}]}}]},availableCommands:[{name:"review",description:"Review"}]}
let authenticated=false, promptId, requestId
const choice=(id,values,currentValue)=>({id,type:"select",name:id,currentValue,options:values.map(value=>({value,name:value}))})
const configs=[choice("mode",["ask","auto"],"ask"),choice("autopilot",["on","off"],"on"),choice("model",["one","two"],"one"),choice(id==="kiro"?"effortLevel":"effort",["low","high"],"low")]
createInterface({input:process.stdin}).on("line",line=>{
  const {id:rid,method,params,result:r}=JSON.parse(line)
  record({method,params,result:r})
  const result=result=>send({id:rid,result})
  if (method==="initialize") return result({protocolVersion:1,_meta:id==="grok"?grokMetadata:{},agentInfo:{name:id,version:"2.0.0"},agentCapabilities:{sessionCapabilities:{resume:{}}},authMethods:[{id:"cached_token",name:"CLI"}]})
  if (method==="authenticate") {authenticated=true;return result({})}
  if (method==="session/new"||method==="session/resume") {
    if(id==="grok"&&!authenticated) return send({id:rid,error:{code:-32000,message:"Authentication required"}})
    return result({sessionId:"session",configOptions:configs})
  }
  if(method==="session/set_config_option") {
    const c=configs.find(c=>c.id===params.configId)
    if(c)c.currentValue=params.value
    if(id==="kiro" && params.configId==="model"){
      result({configOptions:configs.filter(c=>c.id!=="effortLevel")})
      setTimeout(()=>send({method:"session/update",params:{sessionId:"session",update:{sessionUpdate:"config_option_update",configOptions:configs}}}),50)
      return
    }
    return result({configOptions:configs})
  }
  if(method==="session/prompt") {
    promptId=rid;requestId=params._meta?.promptId
    send({method:"session/update",params:{sessionId:"session",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"hello"}}}})
    send({id:"perm",method:"session/request_permission",params:{sessionId:"session",toolCall:{toolCallId:"write",kind:"execute",title:"Sample"},options:[{kind:"allow_once",optionId:"yes",name:"Allow"},{kind:"reject_once",optionId:"no",name:"Deny"}]}})
    return
  }
  if(rid==="perm") {
    if(id==="grok") return send({method:"_x.ai/session/prompt_complete",params:{sessionId:"session",promptId:requestId,stopReason:"end_turn"}})
    send({id:promptId,result:{stopReason:"end_turn"}})
  }
})
`.trimStart()

it.each([grok, fx, kiro])(
  "uses the $id vendor CLI for discovery and a supervised ACP turn",
  async (definition) => {
    const root = await mkdtemp(join(tmpdir(), "pigcode-native-acp-"))
    const executable = join(root, "peer.mjs"),
      log = join(root, "calls.jsonl")
    await writeFile(executable, peer, { mode: 0o700 })
    const bin = process.platform === "win32" ? join(root, "peer.cmd") : executable
    if (bin !== executable) await writeFile(bin, '@SETLOCAL\r\nnode "%~dp0peer.mjs" %*\r\n')
    const driver = new NativeAcpDriver(definition)
    const settings = {
      binaryPath: bin,
      apiKey: "test-token",
      environment: [
        { name: "TEST_ID", value: definition.id },
        { name: "TEST_LOG", value: log },
      ],
    }
    try {
      expect(await driver.detect(settings)).toMatchObject({ installed: true, authenticated: true })
      const models = await driver.listModels(settings)
      if (definition.id === "grok") {
        expect(models).toContainEqual(
          expect.objectContaining({
            id: "two",
            displayName: "Native Two",
            efforts: ["high", "low"],
          }),
        )
        expect(await driver.listCommands(settings, null)).toContainEqual(
          expect.objectContaining({ name: "review" }),
        )
      }
      expect(models).toContainEqual(expect.objectContaining({ id: "two" }))
      const handle = await driver.createSession({
        cwd: root,
        threadId: "t",
        permissionMode: "approval-required",
        model: "two",
        settings,
      })
      const approval = vi.fn(async () => "deny" as const)
      const events: AgentEvent[] = []
      await driver.send(
        handle,
        { text: "demo", effort: "high" },
        {
          signal: new AbortController().signal,
          emit: (event) => events.push(event),
          requestApproval: approval,
        },
      )
      expect(approval).toHaveBeenCalledOnce()
      expect(events).toContainEqual({ type: "message.completed", text: "hello" })
      const calls = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(calls).toContainEqual(
        expect.objectContaining({ result: { outcome: { outcome: "selected", optionId: "no" } } }),
      )
      if (definition.id === "grok") {
        expect(calls).toContainEqual(
          expect.objectContaining({ args: ["--permission-mode", "default", "agent", "stdio"] }),
        )
        expect(calls).toContainEqual({
          method: "authenticate",
          params: { methodId: "cached_token" },
        })
      }
      if (definition.id === "kiro") {
        expect(calls).toContainEqual({
          args: ["acp", "--agent-engine=v3", "--auth-method=cli"],
          key: "test-token",
        })
        expect(calls).toContainEqual(
          expect.objectContaining({
            method: "session/set_config_option",
            params: { sessionId: "session", configId: "autopilot", value: "off" },
          }),
        )
      }
      if (definition.id === "fx") {
        expect(calls).toContainEqual(
          expect.objectContaining({
            method: "session/new",
            params: expect.objectContaining({ _meta: { fx: { profileMcpServers: true } } }),
          }),
        )
        expect(calls).toContainEqual(
          expect.objectContaining({
            method: "session/set_config_option",
            params: { sessionId: "session", configId: "mode", value: "ask" },
          }),
        )
      }
      if (definition.id !== "grok")
        expect(calls).toContainEqual(
          expect.objectContaining({
            method: "session/set_config_option",
            params: {
              sessionId: "session",
              configId: definition.id === "kiro" ? "effortLevel" : "effort",
              value: "high",
            },
          }),
        )
    } finally {
      await driver.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  12_000,
)
