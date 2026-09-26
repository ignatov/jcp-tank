import { afterEach, expect, test } from "bun:test"
import type { Server } from "bun"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { chat, type ChatTarget } from "../src/chat"
import { RunLog } from "../src/run-log"
import { SpawnerHttp } from "../src/spawner"

type Message = Record<string, any>

const CONFIG_OPTIONS = [{ id: "mode", category: "mode", currentValue: "agent", options: [{ value: "read-only" }, { value: "agent" }] }]

/** A fake spawner that echoes each prompt and replays a short history on `session/load`. */
class FakeChatSpawner {
  readonly received: Message[] = []
  readonly http: string[] = []
  status = "FINISHED"
  readonly server: Server<undefined>

  constructor() {
    this.server = Bun.serve({
      port: 0,
      fetch: (request, bun) => {
        const url = new URL(request.url)
        if (url.pathname === "/agent-spawner/acp") {
          return bun.upgrade(request) ? undefined : new Response("", { status: 400 })
        }
        const path = url.pathname.replace("/agent-spawner", "")
        this.http.push(`${request.method} ${path}`)
        if (path.endsWith("/status")) {
          return new Response(JSON.stringify(this.status))
        }
        return request.method === "GET" ? Response.json({ status: "FINISHED", statusComment: "Waiting" }) : new Response(null, { status: 200 })
      },
      websocket: {
        message: (ws, data) => {
          const message = JSON.parse(String(data)) as Message
          this.received.push(message)
          const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
          const update = (update: Record<string, unknown>) =>
            ws.send(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "c-1", update } }))
          const text = (sessionUpdate: string, value: string) => update({ sessionUpdate, content: { type: "text", text: value } })
          switch (message.method) {
            case "initialize":
              reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } })
              break
            case "session/new":
              reply({ sessionId: "c-1", configOptions: CONFIG_OPTIONS })
              break
            case "session/set_config_option":
              reply({ configOptions: CONFIG_OPTIONS })
              break
            case "session/prompt":
              update({ sessionUpdate: "session_info_update", _meta: { status: "LAUNCHING" } })
              text("agent_message_chunk", `echo: ${message.params.prompt[0].text}`)
              reply({ stopReason: "end_turn" })
              break
            case "session/load":
              text("user_message_chunk", "earlier question")
              update({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "earlier answer" } })
              text("agent_message_chunk", "Session is not alive anymore")
              reply({ _meta: { lastRequestStillInFlight: false } })
              break
          }
        },
      },
    })
  }

  async run(target: ChatTarget, lines: readonly string[]): Promise<string> {
    const base = `127.0.0.1:${this.server.port}/agent-spawner`
    const input = new PassThrough()
    lines.forEach((line) => input.write(`${line}\n`))
    input.end()
    let output = ""
    await chat({
      acpUrl: `ws://${base}/acp`,
      spawner: new SpawnerHttp(`http://${base}`, async () => "token"),
      token: "token",
      target,
      webUrl: (sessionId) => `https://air.example/session/${sessionId}`,
      log: await RunLog.create("chat", await mkdtemp(join(tmpdir(), "jcp-tank-chat-"))),
      input,
      write: (text) => output += text,
      terminal: false,
    })
    return output
  }
}

let spawner: FakeChatSpawner | undefined

afterEach(() => {
  void spawner?.server.stop(true)
  spawner = undefined
})

const NEW_SESSION: ChatTarget = {
  kind: "new",
  remote: { url: "https://github.com/ignatov/intellij-erlang.git", branch: "master" },
  settings: [{ key: "mode", value: "read-only" }],
}

test("starts a session, streams the answer, and leaves the session running", async () => {
  spawner = new FakeChatSpawner()

  const output = await spawner.run(NEW_SESSION, ["hello", "/quit"])

  expect(output).toContain("[session] c-1: a draft (mode=read-only)")
  expect(output).toContain("[web] https://air.example/session/c-1")
  expect(output).toContain("[launching the environment]\n[status] LAUNCHING\necho: hello\n[turn end: end_turn")
  expect(output).toContain("Attach: ./jcp-tank chat --session c-1")
  expect(spawner.received.find((m) => m.method === "session/prompt")?.params.prompt).toEqual([{ type: "text", text: "hello" }])
  expect(spawner.http).toEqual([])
})

test("deletes the draft when the chat ends before the first message", async () => {
  spawner = new FakeChatSpawner()

  const output = await spawner.run(NEW_SESSION, ["/quit"])

  expect(output).toContain("[draft deleted: HTTP 200]")
  expect(spawner.http).toEqual(["DELETE /sessions/c-1"])
  expect(spawner.received.map((m) => m.method)).not.toContain("session/prompt")
})

test("attaches to a session with its history and archives it", async () => {
  spawner = new FakeChatSpawner()

  const output = await spawner.run({ kind: "attach", sessionId: "c-1" }, ["/archive"])

  expect(spawner.received.find((m) => m.method === "session/load")?.params).toEqual({ sessionId: "c-1", cwd: "", mcpServers: [], _meta: { jcpToken: "token" } })
  expect(output).toContain("[session] c-1: status \"FINISHED\". Loading the history...")
  expect(output).toContain("you> earlier question\nearlier answer\nSession is not alive anymore\n[history loaded]")
  expect(output).toContain("[archive] HTTP 200")
  expect(output).toContain("[left] The session is ARCHIVED.")
  expect(spawner.http).toEqual(["GET /sessions/c-1/status", "PUT /sessions/c-1/archive"])
})

test("does not call an archived session running when the chat ends", async () => {
  spawner = new FakeChatSpawner()
  spawner.status = "ARCHIVED"

  const output = await spawner.run({ kind: "attach", sessionId: "c-1" }, ["/quit"])

  expect(output).toContain("[left] The session is ARCHIVED. Its history stays: ./jcp-tank chat --session c-1")
  expect(output).not.toContain("keeps running")
})
