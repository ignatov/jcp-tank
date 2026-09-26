import { createHash } from "node:crypto"
import { createServer, type Socket } from "node:net"

/** An unsigned JWT with the claims. The tank never checks signatures. */
export function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.signature`
}

/** Waits until the condition holds, or fails after the timeout. */
export async function until(condition: () => boolean, timeoutMs: number = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`The condition did not hold within ${timeoutMs} ms`)
    }
    await Bun.sleep(5)
  }
}

/** A frame that the client sent, after unmasking. */
export interface ClientFrame {
  readonly opcode: number
  readonly fin: boolean
  readonly masked: boolean
  readonly payload: Buffer
}

export interface RawWebSocketServer {
  readonly url: string
  /** The frames of each connection, in the order the connections came. */
  readonly frames: ClientFrame[][]
  close(): void
}

/**
 * A WebSocket server on a raw socket. A test can write any frame and see every frame of the client.
 * `afterUpgrade` goes in the same write as the 101 response.
 */
export async function rawWebSocketServer(onOpen: (socket: Socket) => void, afterUpgrade?: Buffer): Promise<RawWebSocketServer> {
  const frames: ClientFrame[][] = []
  const server = createServer((socket) => {
    const received: ClientFrame[] = []
    frames.push(received)
    let head: Buffer = Buffer.alloc(0)
    let buffer: Buffer = Buffer.alloc(0)
    let upgraded = false
    socket.on("error", () => {})
    socket.on("data", (chunk: Buffer) => {
      if (upgraded) {
        buffer = parseClientFrames(Buffer.concat([buffer, chunk]), received)
        return
      }
      head = Buffer.concat([head, chunk])
      const end = head.indexOf("\r\n\r\n")
      if (end < 0) {
        return
      }
      const key = /sec-websocket-key: *(.+)\r\n/i.exec(head.toString("latin1"))?.[1]?.trim() ?? ""
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
      const response = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
      socket.write(Buffer.concat([Buffer.from(response, "latin1"), afterUpgrade ?? Buffer.alloc(0)]))
      upgraded = true
      buffer = parseClientFrames(head.subarray(end + 4), received)
      onOpen(socket)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  return { url: `ws://127.0.0.1:${port}/acp`, frames, close: () => server.close() }
}

/** A server frame. A server never masks (RFC 6455 section 5.1). */
export function serverFrame(opcode: number, payload: Buffer | string, fin: boolean = true): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload) : payload
  let header: Buffer
  if (data.length < 126) {
    header = Buffer.from([0, data.length])
  }
  else if (data.length < 65536) {
    header = Buffer.from([0, 126, 0, 0])
    header.writeUInt16BE(data.length, 2)
  }
  else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }
  header[0] = (fin ? 0x80 : 0) | opcode
  return Buffer.concat([header, data])
}

function parseClientFrames(input: Buffer, frames: ClientFrame[]): Buffer {
  let buffer = input
  while (buffer.length >= 2) {
    const masked = (buffer[1]! & 0x80) !== 0
    let length = buffer[1]! & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < 4) {
        break
      }
      length = buffer.readUInt16BE(2)
      offset = 4
    }
    else if (length === 127) {
      if (buffer.length < 10) {
        break
      }
      length = Number(buffer.readBigUInt64BE(2))
      offset = 10
    }
    const maskOffset = offset
    if (masked) {
      offset += 4
    }
    if (buffer.length < offset + length) {
      break
    }
    const payload = Buffer.from(buffer.subarray(offset, offset + length))
    if (masked) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] = payload[i]! ^ buffer[maskOffset + (i & 3)]!
      }
    }
    frames.push({ opcode: buffer[0]! & 0x0f, fin: (buffer[0]! & 0x80) !== 0, masked, payload })
    buffer = buffer.subarray(offset + length)
  }
  return buffer
}
