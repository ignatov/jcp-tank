import { afterEach, expect, test } from "bun:test"
import type { Server, ServerWebSocket } from "bun"
import { ConnectionClosedError, JsonRpcError, JsonRpcPeer, METHOD_NOT_FOUND, MethodError, RequestTimeoutError } from "../src/rpc"
import { openWebSocket } from "../src/ws"
import { until } from "./support"

type Message = Record<string, any>

const servers: Server<undefined>[] = []

afterEach(() => {
  servers.splice(0).forEach((server) => void server.stop(true))
})

/** A JSON-RPC agent that hands every message to the test. */
function agent(onMessage: (ws: ServerWebSocket<undefined>, message: Message) => void): Server<undefined> {
  const server = Bun.serve({
    port: 0,
    fetch: (request, bun) => bun.upgrade(request) ? undefined : new Response("", { status: 400 }),
    websocket: { message: (ws, data) => onMessage(ws, JSON.parse(String(data)) as Message) },
  })
  servers.push(server)
  return server
}

async function connect(server: Server<undefined>, onRequest: (method: string, params: unknown) => unknown = () => {
  throw new MethodError(METHOD_NOT_FOUND, "no")
}): Promise<{ peer: JsonRpcPeer, events: string[] }> {
  const events: string[] = []
  const peer = new JsonRpcPeer({ onNotification: (method) => events.push(`notification ${method}`), onRequest })
  const { connection } = await openWebSocket(`ws://127.0.0.1:${server.port}/`, peer, { pingIntervalMs: 0 })
  peer.attach(connection)
  return { peer, events }
}

test("resolves a request and delivers the notification that came before its response", async () => {
  const server = agent((ws, message) => {
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1" } }))
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { sessionId: "s1" } }))
  })
  const { peer, events } = await connect(server)

  const result = await peer.request("session/new", {}, 1000)
  events.push("response")

  expect(result).toEqual({ sessionId: "s1" })
  expect(events).toEqual(["notification session/update", "response"])
})

test("rejects a request with the JSON-RPC error of its response", async () => {
  const server = agent((ws, message) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "bad params" } })))
  const { peer } = await connect(server)

  const error = await peer.request("session/new", {}, 1000).catch((e: unknown) => e)

  expect(error).toBeInstanceOf(JsonRpcError)
  expect((error as JsonRpcError).error).toEqual({ code: -32602, message: "bad params" })
})

test("answers a request of the agent, and answers method not found for an unknown one", async () => {
  const answers: Message[] = []
  const server = agent((ws, message) => {
    if (message.method === "go") {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: {} }))
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "fs/read_text_file", params: {} }))
    }
    else {
      answers.push(message)
    }
  })
  const { peer } = await connect(server, (method) => {
    if (method === "session/request_permission") {
      return { outcome: { outcome: "cancelled" } }
    }
    throw new MethodError(METHOD_NOT_FOUND, `no ${method}`)
  })

  peer.notify("go", {})
  await until(() => answers.length === 2)

  // JSON-RPC does not order the responses.
  expect(answers.sort((a, b) => a.id - b.id)).toEqual([
    { jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "cancelled" } } },
    { jsonrpc: "2.0", id: 8, error: { code: -32601, message: "no fs/read_text_file" } },
  ])
})

test("times out a request and ignores its late response", async () => {
  const server = agent((ws, message) => setTimeout(() => ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: 1 })), 100))
  const { peer } = await connect(server)

  const error = await peer.request("slow", {}, 20).catch((e: unknown) => e)
  await Bun.sleep(150)

  expect(error).toBeInstanceOf(RequestTimeoutError)
})

test("rejects the pending requests when the connection closes", async () => {
  const server = agent((ws) => ws.close(1011, "internal"))
  const { peer } = await connect(server)

  const error = await peer.request("session/prompt", {}, 0).catch((e: unknown) => e)

  expect(error).toBeInstanceOf(ConnectionClosedError)
  expect((error as ConnectionClosedError).event).toMatchObject({ code: 1011, reason: "internal" })
})
