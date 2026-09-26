import { afterEach, expect, test } from "bun:test"
import type { Server } from "bun"
import { HandshakeError, openWebSocket, type CloseEvent, type WebSocketHandlers } from "../src/ws"
import { rawWebSocketServer, serverFrame, until, type RawWebSocketServer } from "./support"

const cleanups: (() => void)[] = []

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
})

function recorder(): { texts: string[], closed: () => CloseEvent | undefined, handlers: WebSocketHandlers } {
  const texts: string[] = []
  let closed: CloseEvent | undefined
  return {
    texts,
    closed: () => closed,
    handlers: { onText: (text) => texts.push(text), onClose: (event) => closed = event },
  }
}

function serve<T>(options: Parameters<typeof Bun.serve<T>>[0]): Server<T> {
  const server = Bun.serve<T>(options)
  cleanups.push(() => void server.stop(true))
  return server
}

async function raw(onOpen: Parameters<typeof rawWebSocketServer>[0], afterUpgrade?: Buffer): Promise<RawWebSocketServer> {
  const server = await rawWebSocketServer(onOpen, afterUpgrade)
  cleanups.push(() => server.close())
  return server
}

test("exchanges text frames of every length class with the WebSocket server of Bun", async () => {
  const server = serve<{ auth: string | null }>({
    port: 0,
    fetch: (request, bun) => bun.upgrade(request, { data: { auth: request.headers.get("authorization") } }) ? undefined : new Response("", { status: 400 }),
    websocket: {
      open: (ws) => void ws.send(`auth:${ws.data.auth}`),
      message: (ws, message) => void ws.send(`echo:${String(message)}`),
    },
  })
  const client = recorder()
  const small = "ünïcode ✓"
  const medium = "m".repeat(300)
  const large = "L".repeat(70_000)

  const { connection, timing } = await openWebSocket(`ws://127.0.0.1:${server.port}/acp`, client.handlers, { headers: { Authorization: "Bearer t" } })
  for (const text of [small, medium, large]) {
    connection.sendText(text)
  }
  await until(() => client.texts.length === 4)
  connection.close()
  await until(() => client.closed() !== undefined)

  expect(client.texts).toEqual(["auth:Bearer t", `echo:${small}`, `echo:${medium}`, `echo:${large}`])
  expect(timing.upgradeMs).toBeGreaterThan(0)
  expect(client.closed()).toMatchObject({ code: 1000, byClient: true })
  expect(client.closed()?.error).toBeUndefined()
})

test("reports the status, the headers, and the body of a rejected handshake", async () => {
  const server = serve({
    port: 0,
    fetch: () => new Response("The organization is not entitled", { status: 403, headers: { "x-request-id": "req-1" } }),
  })

  const error = await openWebSocket(`ws://127.0.0.1:${server.port}/acp`, recorder().handlers).catch((e: unknown) => e)

  expect(error).toBeInstanceOf(HandshakeError)
  expect(error).toMatchObject({ status: 403, body: "The organization is not entitled" })
  expect((error as HandshakeError).headers["x-request-id"]).toBe("req-1")
})

test("decodes a chunked body of a rejected handshake", async () => {
  const server = serve({
    port: 0,
    fetch: () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("slow "))
        controller.enqueue(new TextEncoder().encode("down"))
        controller.close()
      },
    }), { status: 429 }),
  })

  const error = await openWebSocket(`ws://127.0.0.1:${server.port}/acp`, recorder().handlers).catch((e: unknown) => e)

  expect(error).toMatchObject({ status: 429, body: "slow down" })
})

test("reports the close code and the reason that the server sends", async () => {
  const server = serve<undefined>({
    port: 0,
    fetch: (request, bun) => bun.upgrade(request) ? undefined : new Response("", { status: 400 }),
    websocket: { open: (ws) => ws.close(4001, "session ended"), message: () => {} },
  })
  const client = recorder()

  await openWebSocket(`ws://127.0.0.1:${server.port}/acp`, client.handlers)
  await until(() => client.closed() !== undefined)

  expect(client.closed()).toMatchObject({ code: 4001, reason: "session ended", byClient: false })
  expect(client.closed()?.error).toBeUndefined()
})

test("joins a fragmented message and answers a ping between its fragments", async () => {
  const server = await raw((socket) => {
    socket.write(Buffer.concat([serverFrame(0x1, "{\"part\":", false), serverFrame(0x9, "keepalive"), serverFrame(0x0, "1", false), serverFrame(0x0, "}")]))
  })
  const client = recorder()

  await openWebSocket(server.url, client.handlers)
  await until(() => client.texts.length === 1 && server.frames[0]!.some((frame) => frame.opcode === 0xa))

  expect(client.texts).toEqual(["{\"part\":1}"])
  expect(server.frames[0]!.find((frame) => frame.opcode === 0xa)?.payload.toString()).toBe("keepalive")
})

test("masks every frame and encodes each length class", async () => {
  const server = await raw(() => {})
  const texts = ["s", "m".repeat(200), "L".repeat(70_000)]

  const { connection } = await openWebSocket(server.url, recorder().handlers)
  texts.forEach((text) => connection.sendText(text))
  await until(() => server.frames[0]!.length === 3)

  expect(server.frames[0]!.map((frame) => ({ masked: frame.masked, text: frame.payload.toString() }))).toEqual(texts.map((text) => ({ masked: true, text })))
})

test("delivers a frame that arrives in the same packet as the 101 response", async () => {
  const server = await raw(() => {}, serverFrame(0x1, "early"))
  const client = recorder()

  await openWebSocket(server.url, client.handlers)
  await until(() => client.texts.length === 1)

  expect(client.texts).toEqual(["early"])
})

test("fails the connection when no pong comes", async () => {
  const server = await raw(() => {})
  const client = recorder()

  await openWebSocket(server.url, client.handlers, { pingIntervalMs: 30, pongTimeoutMs: 60 })
  await until(() => client.closed() !== undefined)

  expect(client.closed()?.error?.message).toContain("No pong")
  expect(server.frames[0]!.some((frame) => frame.opcode === 0x9)).toBe(true)
})

test("reports a connection that ends without a close frame", async () => {
  const server = await raw((socket) => setTimeout(() => socket.destroy(), 10))
  const client = recorder()

  await openWebSocket(server.url, client.handlers)
  await until(() => client.closed() !== undefined)

  expect(client.closed()?.error?.message).toContain("without a close frame")
})
