import { afterEach, expect, test } from "bun:test"
import type { Server } from "bun"
import { AcpClient, answerAgentRequest, type SessionUpdate } from "../src/acp"
import { maskSecrets } from "../src/run-log"
import { SpawnerHttp } from "../src/spawner"
import { HandshakeError } from "../src/ws"
import { until } from "./support"

type Message = Record<string, any>

const TOKEN = "spawner-token"
const REMOTE = { url: "https://github.com/ignatov/intellij-erlang.git", branch: "master" }

/**
 * A fake agent spawner: the ACP endpoint behind a Bearer check, and the HTTP draft deletion. It behaves like
 * `FakeSpawnerAcpAgent` of the Air tests: an update can come before the `session/new` response.
 */
class FakeSpawner {
  readonly received: Message[] = []
  readonly deleted: { id: string, authorization: string | null }[] = []
  readonly server: Server<undefined>

  constructor() {
    this.server = Bun.serve({
      port: 0,
      fetch: (request, bun) => {
        const url = new URL(request.url)
        if (url.pathname === "/agent-spawner/acp") {
          if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
            return new Response("Unauthorized", { status: 401 })
          }
          return bun.upgrade(request) ? undefined : new Response("", { status: 400 })
        }
        const draft = /^\/agent-spawner\/sessions\/([^/]+)$/.exec(url.pathname)
        if (draft !== null && request.method === "DELETE") {
          this.deleted.push({ id: draft[1]!, authorization: request.headers.get("authorization") })
          return new Response(null, { status: 204 })
        }
        return new Response("not found", { status: 404 })
      },
      websocket: {
        message: (ws, data) => {
          const message = JSON.parse(String(data)) as Message
          this.received.push(message)
          const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
          const update = (sessionId: string, text: string) => ws.send(JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
          }))
          switch (message.method) {
            case "initialize":
              reply({ protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "fake-spawner", version: "1" }, authMethods: [] })
              break
            case "session/new":
              update("draft-1", "Read access to `ignatov/intellij-erlang` is required")
              reply({ sessionId: "draft-1", configOptions: [{ id: "_agent", category: "_agent", type: "select", currentValue: "junie", options: [{ value: "junie", name: "Junie" }] }] })
              break
            case "session/prompt":
              update(message.params.sessionId, "I am fine. MARKER-42")
              reply({ stopReason: "end_turn" })
              break
          }
        },
      },
    })
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.server.port}/agent-spawner`
  }

  get acpUrl(): string {
    return `ws://127.0.0.1:${this.server.port}/agent-spawner/acp`
  }
}

let spawner: FakeSpawner | undefined

afterEach(() => {
  void spawner?.server.stop(true)
  spawner = undefined
})

test("speaks the wire protocol of the Air cloud client", async () => {
  spawner = new FakeSpawner()
  const updates: SessionUpdate[] = []
  const client = await AcpClient.connect(spawner.acpUrl, TOKEN, { onUpdate: (update) => updates.push(update) })

  await client.initialize()
  const draft = await client.newSession(REMOTE, TOKEN)
  const updatesBeforeResponse = updates.length
  const turn = await client.prompt("draft-1", "How are you? Include MARKER-42.", TOKEN)
  client.close()

  const [initialize, sessionNew, prompt] = spawner.received
  expect(initialize?.params).toEqual({
    protocolVersion: 1,
    clientCapabilities: expect.objectContaining({ terminal: false, elicitation: { form: {} } }),
    clientInfo: { name: "jcp-tank", version: "0.1.0", title: "JCP Tank" },
  })
  expect(initialize?.params.clientCapabilities.fs).toBeUndefined()
  expect(sessionNew?.params).toEqual({ cwd: "", mcpServers: [], _meta: { jcpToken: TOKEN, remote: REMOTE } })
  expect(prompt?.params._meta.jcpToken).toBe(TOKEN)
  expect(draft.sessionId).toBe("draft-1")
  expect(updatesBeforeResponse).toBe(1)
  expect(updates.map((update) => update.update.content)).toEqual([
    { type: "text", text: "Read access to `ignatov/intellij-erlang` is required" },
    { type: "text", text: "I am fine. MARKER-42" },
  ])
  expect(turn).toEqual({ stopReason: "end_turn" })
})

test("fails the handshake with the status when the token is wrong", async () => {
  spawner = new FakeSpawner()

  const error = await AcpClient.connect(spawner.acpUrl, "wrong").catch((e: unknown) => e)

  expect(error).toBeInstanceOf(HandshakeError)
  expect(error).toMatchObject({ status: 401, body: "Unauthorized" })
})

test("deletes a draft over HTTP with the Bearer token", async () => {
  spawner = new FakeSpawner()
  const http = new SpawnerHttp(spawner.baseUrl, async () => TOKEN)

  const outcome = await http.deleteSession("draft-1")
  await until(() => spawner!.deleted.length === 1)

  expect(outcome.status).toBe(204)
  expect(spawner.deleted).toEqual([{ id: "draft-1", authorization: `Bearer ${TOKEN}` }])
})

test("allows a permission once only when the policy allows it", () => {
  const request = { options: [{ optionId: "a1", kind: "allow_always" }, { optionId: "a2", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }] }

  expect(answerAgentRequest("session/request_permission", request, "allow")).toEqual({ outcome: { outcome: "selected", optionId: "a2" } })
  expect(answerAgentRequest("session/request_permission", request, "deny")).toEqual({ outcome: { outcome: "cancelled" } })
  expect(answerAgentRequest("session/request_permission", { options: [{ optionId: "r", kind: "reject_once" }] }, "allow")).toEqual({ outcome: { outcome: "cancelled" } })
  expect(() => answerAgentRequest("fs/read_text_file", {}, "allow")).toThrow("does not implement fs/read_text_file")
})

test("masks every jcpToken in a frame", () => {
  const frame = JSON.stringify({ params: { _meta: { jcpToken: "secret-1" } }, other: { "jcpToken" : "secret-2" } })

  expect(maskSecrets(frame)).not.toContain("secret")
  expect(maskSecrets("{\"jcpToken\" : \"secret-3\"}")).toBe("{\"jcpToken\" : \"***\"}")
})
