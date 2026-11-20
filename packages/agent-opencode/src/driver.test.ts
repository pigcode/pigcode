import { createServer, type ServerResponse } from "node:http"
import { expect, it } from "vitest"
import type { AgentEvent } from "@pigcode/contracts"
import { OpenCodeDriver } from "./driver"

async function fixture(major: 1 | 2) {
  const events = new Set<ServerResponse>()
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = []
  let parentReply: ServerResponse | undefined,
    messageID = ""
  const notify = (type: string, value: object) => {
    const packet = major === 2 ? { type, data: value } : { type, properties: value }
    for (const event of events) event.write("data: " + JSON.stringify(packet) + "\r\n\r\n")
  }
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname
    if (req.headers.authorization !== "Basic " + Buffer.from("opencode:口令").toString("base64")) {
      res.writeHead(401).end()
      return
    }
    let text = ""
    for await (const value of req) text += value
    const body = text ? JSON.parse(text) : {}
    calls.push({ method: req.method!, path, body })
    const json = (data: unknown) =>
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(data))
    if (path === "/api/info") {
      if (major === 2) json({ version: "2.3.2", pid: 123 })
      else res.writeHead(404).end()
      return
    }
    if (path === "/global/health" && major === 1) {
      json({ healthy: true, version: "1.14.19" })
      return
    }
    if (path === "/api/model" && major === 2) {
      json({ data: [{ providerID: "demo", id: "alpha", name: "Alpha" }] })
      return
    }
    if (path === "/provider" && major === 1) {
      json({
        all: [{ id: "demo", models: { alpha: { name: "Alpha" } } }],
        connected: ["demo"],
        default: { demo: "alpha" },
      })
      return
    }
    const base = major === 2 ? "/api/session" : "/session",
      session = base + "/ses_demo"
    if (path === base && req.method === "POST") {
      json(major === 2 ? { data: { id: "ses_demo" } } : { id: "ses_demo" })
      return
    }
    if ([session, session + "/agent", session + "/model"].includes(path)) {
      json({ id: "ses_demo" })
      return
    }
    if (path === (major === 2 ? "/api/event" : "/event")) {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(": subscribed\n\n")
      events.add(res)
      res.once("close", () => events.delete(res))
      return
    }
    if (path === session + (major === 2 ? "/prompt" : "/message")) {
      messageID = major === 2 ? body.id : body.messageID
      const hold = major === 2 ? body.text === "hold" : body.parts[0].text === "hold"
      if (major === 2) {
        json({ data: { id: messageID } })
        notify("session.inbox.delivered", { sessionID: "ses_demo", inboxID: messageID })
      } else parentReply = res
      if (!hold) {
        notify("permission.asked", {
          sessionID: "ses_demo",
          id: "per_demo",
          [major === 2 ? "action" : "permission"]: "shell",
          [major === 2 ? "resources" : "patterns"]: ["echo test"],
        })
      }
      return
    }
    if (
      path === (major === 2 ? session + "/permission/per_demo/reply" : "/permission/per_demo/reply")
    ) {
      res.writeHead(204).end()
      if (major === 2) {
        notify("session.text.delta", { sessionID: "unrelated", delta: "foreign" })
        notify("session.text.delta", {
          sessionID: "ses_demo",
          assistantMessageID: "msg_reply",
          ordinal: 1,
          delta: "answer",
        })
        notify("session.text.ended", {
          sessionID: "ses_demo",
          assistantMessageID: "msg_reply",
          ordinal: 1,
          text: "answer",
        })
        notify("session.execution.succeeded", { sessionID: "ses_demo" })
      } else {
        notify("message.part.updated", {
          sessionID: "ses_demo",
          part: { sessionID: "ses_demo", messageID: "msg_reply", id: "part1", type: "text" },
        })
        notify("message.part.delta", {
          sessionID: "ses_demo",
          messageID: "msg_reply",
          partID: "part1",
          field: "text",
          delta: "answer",
        })
        // The blocking 1.x response is authoritative for complete parts.
        setTimeout(
          () =>
            parentReply?.end(
              JSON.stringify({
                info: { tokens: { input: 1 } },
                parts: [{ type: "text", text: "answer" }],
              }),
            ),
          20,
        )
      }
      return
    }
    if (path === session + (major === 2 ? "/interrupt" : "/abort")) {
      json(true)
      parentReply?.end("{}")
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("test server has no port")
  return {
    calls,
    settings: { serverUrl: "http://127.0.0.1:" + address.port, serverPassword: "口令" },
    close: async () => {
      for (const res of events) res.end()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

it.each([1, 2] as const)(
  "speaks OpenCode %s HTTP, streams an answer, restores native state and can interrupt",
  async (major) => {
    const host = await fixture(major),
      driver = new OpenCodeDriver()
    const { settings } = host
    const cwd = process.cwd()
    try {
      const detected = await driver.detect(settings)
      expect(detected).toMatchObject({
        installed: true,
        version: major === 1 ? "1.14.19" : "2.3.2",
      })
      expect(await driver.listModels(settings)).toMatchObject([{ id: "demo/alpha" }])
      const input = {
        threadId: "thread",
        cwd,
        model: "demo/alpha",
        settings,
        permissionMode: "approval-required",
      }
      const session = await driver.createSession(input)
      const events: AgentEvent[] = []
      await driver.send(
        session,
        { text: "hello" },
        {
          signal: new AbortController().signal,
          emit: (e) => events.push(e),
          requestApproval: async (req) => {
            expect(req.toolName).toBe("shell")
            return "allow-for-session"
          },
        },
      )
      expect(events).toContainEqual({ type: "message.delta", text: "answer" })
      expect(events).toContainEqual({ type: "message.completed", text: "answer" })
      expect(events).not.toContainEqual({ type: "message.delta", text: "foreign" })
      expect(host.calls.find((call) => call.path.endsWith("/per_demo/reply"))?.body).toEqual(
        major === 2 ? { decision: "once" } : { reply: "once" },
      )
      const second = await driver.createSession({
        ...input,
        sessionId: session.id,
        nativeSessionId: session.nativeSessionId,
      })
      expect(second.nativeSessionId).toBe(session.nativeSessionId)
      const pending = driver.send(
        second,
        { text: "hold" },
        {
          signal: new AbortController().signal,
          emit: () => undefined,
          requestApproval: async () => "deny",
        },
      )
      await expect
        .poll(() =>
          host.calls.filter((call) => call.path.endsWith(major === 2 ? "/prompt" : "/message")),
        )
        .toHaveLength(2)
      await driver.interrupt(second)
      await pending
      expect(
        host.calls.some((call) => call.path.endsWith(major === 2 ? "/interrupt" : "/abort")),
      ).toBe(true)
      const plan = await driver.createSession({
        ...input,
        sessionId: second.id,
        nativeSessionId: second.nativeSessionId,
        permissionMode: "full-access",
        planMode: true,
      })
      const patched = host.calls.filter((call) => call.method === "PATCH").at(-1)?.body
      const rules = major === 2 ? patched?.permissions : patched?.permission
      const expected = (name: string, mode: string) =>
        major === 2
          ? { action: name, resource: "*", effect: mode }
          : { permission: name, pattern: "*", action: mode }
      expect(rules).toContainEqual(expected("*", "deny"))
      expect(rules).toContainEqual(expected("read", "allow"))
      expect(rules).not.toContainEqual(expected("*", "allow"))
      await driver.dispose(plan)
      expect((await driver.detect({ ...settings, serverPassword: "incorrect" })).installed).toBe(
        false,
      )
    } finally {
      await driver.close()
      await host.close()
    }
  },
  10_000,
)
