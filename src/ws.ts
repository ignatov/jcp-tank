import { createHash, randomBytes } from "node:crypto"
import { connect as netConnect, type Socket } from "node:net"
import { connect as tlsConnect } from "node:tls"

const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
const MAX_HANDSHAKE_BYTES = 64 * 1024
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024
const REJECTION_BODY_WAIT_MS = 1000
const CLOSE_WAIT_MS = 3000

const OPCODE_CONTINUATION = 0x0
const OPCODE_TEXT = 0x1
const OPCODE_BINARY = 0x2
const OPCODE_CLOSE = 0x8
const OPCODE_PING = 0x9
const OPCODE_PONG = 0xa

/** The server answered the upgrade request with a status other than 101. */
export class HandshakeError extends Error {
  override readonly name = "HandshakeError"

  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly headers: Readonly<Record<string, string>>,
    readonly body: string,
  ) {
    super(`The WebSocket handshake was rejected: HTTP ${status} ${statusText}${body === "" ? "" : `: ${body.slice(0, 300)}`}`.trim())
  }
}

/** When each step of the connection finished, in milliseconds from the start of the connect call. */
export interface ConnectTiming {
  /** The TCP connection. Absent when the TLS socket reports no separate TCP step. */
  readonly tcpMs?: number
  /** The TLS handshake, for `wss:` only. */
  readonly tlsMs?: number
  /** The `101 Switching Protocols` response. */
  readonly upgradeMs: number
}

export interface CloseEvent {
  /** The code of the close frame, or `undefined` when no close frame arrived. */
  readonly code?: number
  readonly reason: string
  /** Set when the connection failed: a socket error, a protocol error, or a missing pong. */
  readonly error?: Error
  /** True when this client sent the first close frame. */
  readonly byClient: boolean
}

export interface WebSocketHandlers {
  onText(text: string): void
  onClose(event: CloseEvent): void
}

export interface ConnectOptions {
  readonly headers?: Readonly<Record<string, string>>
  /** The budget for the TCP connection, the TLS handshake, and the upgrade. */
  readonly timeoutMs?: number
  /** 0 disables the keepalive ping. */
  readonly pingIntervalMs?: number
  readonly pongTimeoutMs?: number
}

export interface OpenedWebSocket {
  readonly connection: WebSocketConnection
  readonly timing: ConnectTiming
  readonly responseHeaders: Readonly<Record<string, string>>
}

/**
 * Opens a WebSocket (RFC 6455) on a raw TCP or TLS socket. Bun's own client hides the status of a rejected
 * handshake. A load test must tell a 403 from a 429 or a 503, so the tank speaks the protocol itself.
 */
export function openWebSocket(url: string, handlers: WebSocketHandlers, options: ConnectOptions = {}): Promise<OpenedWebSocket> {
  const target = new URL(url)
  const secure = target.protocol === "wss:"
  if (!secure && target.protocol !== "ws:") {
    return Promise.reject(new Error(`Not a WebSocket URL: ${url}`))
  }
  const host = target.hostname
  const port = target.port === "" ? (secure ? 443 : 80) : Number(target.port)
  const key = randomBytes(16).toString("base64")
  const timeoutMs = options.timeoutMs ?? 30_000
  const started = performance.now()
  const since = () => Math.round((performance.now() - started) * 10) / 10

  return new Promise((resolve, reject) => {
    const socket: Socket = secure
      ? tlsConnect({ host, port, servername: host, ALPNProtocols: ["http/1.1"] })
      : netConnect({ host, port })
    let tcpMs: number | undefined
    let tlsMs: number | undefined
    let head = Buffer.alloc(0)
    let settled = false

    const fail = (error: Error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }
    const timer = setTimeout(() => fail(new Error(`The WebSocket handshake took longer than ${timeoutMs} ms`)), timeoutMs)
    const onEarlyClose = () => fail(new Error("The connection closed during the WebSocket handshake"))

    const sendUpgrade = () => {
      const lines = [
        `GET ${target.pathname === "" ? "/" : target.pathname}${target.search} HTTP/1.1`,
        `Host: ${target.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        ...Object.entries(options.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
      ]
      socket.write(`${lines.join("\r\n")}\r\n\r\n`)
    }

    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk])
      const headEnd = head.indexOf("\r\n\r\n")
      if (headEnd < 0) {
        if (head.length > MAX_HANDSHAKE_BYTES) {
          fail(new Error("The handshake response head is too large"))
        }
        return
      }
      socket.off("data", onData)
      const [statusLine = "", ...headerLines] = head.subarray(0, headEnd).toString("latin1").split("\r\n")
      const rest = head.subarray(headEnd + 4)
      const status = /^HTTP\/1\.[01] (\d{3}) ?(.*)$/.exec(statusLine)
      if (status === null) {
        fail(new Error(`The server did not answer with HTTP: ${statusLine.slice(0, 100)}`))
        return
      }
      const headers = parseHeaders(headerLines)
      const code = Number(status[1])
      if (code !== 101) {
        clearTimeout(timer)
        socket.off("close", onEarlyClose)
        socket.off("error", fail)
        void readRejectionBody(socket, rest, headers).then((body) => fail(new HandshakeError(code, status[2] ?? "", headers, body)))
        return
      }
      const expected = createHash("sha1").update(key + ACCEPT_GUID).digest("base64")
      if (headers.upgrade?.toLowerCase() !== "websocket" || headers["sec-websocket-accept"] !== expected) {
        fail(new Error("The server answered 101 without a valid WebSocket upgrade"))
        return
      }
      settled = true
      clearTimeout(timer)
      socket.off("close", onEarlyClose)
      socket.off("error", fail)
      const connection = new WebSocketConnection(socket, handlers, options)
      resolve({ connection, timing: { tcpMs, tlsMs, upgradeMs: since() }, responseHeaders: headers })
      if (rest.length > 0) {
        queueMicrotask(() => connection.receive(rest))
      }
    }

    socket.once("connect", () => {
      tcpMs = since()
      if (!secure) {
        sendUpgrade()
      }
    })
    if (secure) {
      socket.once("secureConnect", () => {
        tlsMs = since()
        sendUpgrade()
      })
    }
    socket.on("data", onData)
    socket.once("error", fail)
    socket.once("close", onEarlyClose)
  })
}

/**
 * An open WebSocket. It sends one text frame per message, answers pings, and pings the server the way the Air
 * transport does: every 30 s, with 10 s for the pong.
 */
export class WebSocketConnection {
  private buffer: Buffer = Buffer.alloc(0)
  private fragments: Buffer[] = []
  private fragmentOpcode: number | undefined
  private fragmentBytes = 0
  private readonly decoder = new TextDecoder()
  private closeSent = false
  private finished = false
  private keepalive: ReturnType<typeof setInterval> | undefined
  private pongTimer: ReturnType<typeof setTimeout> | undefined
  private closeTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly socket: Socket, private readonly handlers: WebSocketHandlers, options: ConnectOptions) {
    socket.on("data", (chunk: Buffer) => this.receive(chunk))
    socket.on("error", (error: Error) => this.fail(error))
    socket.on("close", () => this.finish({
      reason: "",
      byClient: this.closeSent,
      error: this.closeSent ? undefined : new Error("The connection closed without a close frame"),
    }))
    const interval = options.pingIntervalMs ?? 30_000
    if (interval > 0) {
      this.startKeepalive(interval, options.pongTimeoutMs ?? 10_000)
    }
  }

  get isOpen(): boolean {
    return !this.finished && !this.closeSent
  }

  sendText(text: string): void {
    if (!this.isOpen) {
      throw new Error("The WebSocket is not open")
    }
    this.sendFrame(OPCODE_TEXT, Buffer.from(text, "utf8"))
  }

  /** Starts the close handshake. The socket closes when the server answers, or after 3 s. */
  close(code: number = 1000, reason: string = ""): void {
    if (this.finished || this.closeSent) {
      return
    }
    this.closeSent = true
    this.sendFrame(OPCODE_CLOSE, closePayload(code, reason))
    this.closeTimer = setTimeout(() => this.socket.destroy(), CLOSE_WAIT_MS)
  }

  /** Parses the bytes that arrived on the socket. The handshake passes the bytes that followed the 101 response. */
  receive(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    while (!this.finished && this.buffer.length >= 2) {
      const first = this.buffer[0]!
      const second = this.buffer[1]!
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) {
          return
        }
        length = this.buffer.readUInt16BE(2)
        offset = 4
      }
      else if (length === 127) {
        if (this.buffer.length < 10) {
          return
        }
        const big = this.buffer.readBigUInt64BE(2)
        if (big > BigInt(MAX_MESSAGE_BYTES)) {
          this.protocolError(1009, `A frame of ${big} bytes is too large`)
          return
        }
        length = Number(big)
        offset = 10
      }
      const masked = (second & 0x80) !== 0
      const maskOffset = offset
      if (masked) {
        offset += 4
      }
      if (this.buffer.length < offset + length) {
        return
      }
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length))
      if (masked) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] = payload[i]! ^ this.buffer[maskOffset + (i & 3)]!
        }
      }
      this.buffer = this.buffer.subarray(offset + length)
      this.handleFrame((first & 0x80) !== 0, first & 0x0f, payload)
    }
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case OPCODE_TEXT:
      case OPCODE_BINARY:
        if (this.fragmentOpcode !== undefined) {
          this.protocolError(1002, "A new message started inside a fragmented message")
          return
        }
        if (fin) {
          this.deliver(opcode, payload)
        }
        else {
          this.fragmentOpcode = opcode
          this.fragments = [payload]
          this.fragmentBytes = payload.length
        }
        return
      case OPCODE_CONTINUATION:
        if (this.fragmentOpcode === undefined) {
          this.protocolError(1002, "A continuation frame arrived outside a fragmented message")
          return
        }
        this.fragments.push(payload)
        this.fragmentBytes += payload.length
        if (this.fragmentBytes > MAX_MESSAGE_BYTES) {
          this.protocolError(1009, "The message is too large")
          return
        }
        if (fin) {
          const whole = Buffer.concat(this.fragments)
          const messageOpcode = this.fragmentOpcode
          this.fragmentOpcode = undefined
          this.fragments = []
          this.fragmentBytes = 0
          this.deliver(messageOpcode, whole)
        }
        return
      case OPCODE_PING:
        this.sendFrame(OPCODE_PONG, payload)
        return
      case OPCODE_PONG:
        clearTimeout(this.pongTimer)
        this.pongTimer = undefined
        return
      case OPCODE_CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : undefined
        const reason = payload.length > 2 ? this.decoder.decode(payload.subarray(2)) : ""
        const byClient = this.closeSent
        if (!this.closeSent) {
          this.closeSent = true
          this.sendFrame(OPCODE_CLOSE, code === undefined ? Buffer.alloc(0) : closePayload(code, ""))
        }
        this.finish({ code, reason, byClient })
        this.socket.end()
        return
      }
      default:
        this.protocolError(1002, `Unknown opcode ${opcode}`)
    }
  }

  private deliver(opcode: number, payload: Buffer): void {
    // Air ignores binary frames too: every ACP message is a text frame.
    if (opcode === OPCODE_TEXT) {
      this.handlers.onText(this.decoder.decode(payload))
    }
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed) {
      return
    }
    const length = payload.length
    let header: Buffer
    if (length < 126) {
      header = Buffer.alloc(2)
      header[1] = 0x80 | length
    }
    else if (length < 65536) {
      header = Buffer.alloc(4)
      header[1] = 0x80 | 126
      header.writeUInt16BE(length, 2)
    }
    else {
      header = Buffer.alloc(10)
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    header[0] = 0x80 | opcode
    const mask = randomBytes(4)
    const body = Buffer.allocUnsafe(length)
    for (let i = 0; i < length; i++) {
      body[i] = payload[i]! ^ mask[i & 3]!
    }
    this.socket.write(Buffer.concat([header, mask, body]))
  }

  private startKeepalive(intervalMs: number, pongTimeoutMs: number): void {
    this.keepalive = setInterval(() => {
      if (this.pongTimer !== undefined || !this.isOpen) {
        return
      }
      this.sendFrame(OPCODE_PING, randomBytes(8))
      this.pongTimer = setTimeout(() => this.fail(new Error(`No pong within ${pongTimeoutMs} ms`)), pongTimeoutMs)
    }, intervalMs)
  }

  private protocolError(code: number, message: string): void {
    this.sendFrame(OPCODE_CLOSE, closePayload(code, ""))
    this.fail(new Error(`WebSocket protocol error: ${message}`))
  }

  private fail(error: Error): void {
    if (this.finished) {
      return
    }
    this.socket.destroy()
    this.finish({ reason: "", byClient: this.closeSent, error })
  }

  private finish(event: CloseEvent): void {
    if (this.finished) {
      return
    }
    this.finished = true
    clearInterval(this.keepalive)
    clearTimeout(this.pongTimer)
    clearTimeout(this.closeTimer)
    this.handlers.onClose(event)
  }
}

function closePayload(code: number, reason: string): Buffer {
  const text = Buffer.from(reason, "utf8").subarray(0, 123)
  const payload = Buffer.alloc(2 + text.length)
  payload.writeUInt16BE(code, 0)
  text.copy(payload, 2)
  return payload
}

function parseHeaders(lines: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of lines) {
    const colon = line.indexOf(":")
    if (colon > 0) {
      const name = line.slice(0, colon).trim().toLowerCase()
      const value = line.slice(colon + 1).trim()
      headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`
    }
  }
  return headers
}

/** Reads the body of a rejected upgrade: the reason that the server gives for a 403 or a 429. */
function readRejectionBody(socket: Socket, initial: Buffer, headers: Readonly<Record<string, string>>): Promise<string> {
  return new Promise((resolve) => {
    const length = headers["content-length"] === undefined ? undefined : Number(headers["content-length"])
    let body = initial
    let done = false
    const finish = () => {
      if (done) {
        return
      }
      done = true
      clearTimeout(timer)
      socket.off("data", onData)
      socket.off("end", finish)
      socket.off("close", finish)
      socket.off("error", finish)
      const chunked = headers["transfer-encoding"]?.toLowerCase().includes("chunked") === true
      resolve((chunked ? decodeChunked(body) : body).subarray(0, 4096).toString("utf8").trim())
    }
    const complete = () => (length !== undefined && body.length >= length) || body.length > MAX_HANDSHAKE_BYTES ||
                           (headers["transfer-encoding"] !== undefined && body.includes("0\r\n\r\n"))
    const onData = (chunk: Buffer) => {
      body = Buffer.concat([body, chunk])
      if (complete()) {
        finish()
      }
    }
    const timer = setTimeout(finish, REJECTION_BODY_WAIT_MS)
    if (complete() || length === 0) {
      finish()
      return
    }
    socket.on("data", onData)
    socket.once("end", finish)
    socket.once("close", finish)
    socket.once("error", finish)
  })
}

function decodeChunked(data: Buffer): Buffer {
  const parts: Buffer[] = []
  let offset = 0
  while (offset < data.length) {
    const lineEnd = data.indexOf("\r\n", offset)
    if (lineEnd < 0) {
      break
    }
    const size = Number.parseInt(data.subarray(offset, lineEnd).toString("latin1"), 16)
    if (!Number.isFinite(size) || size <= 0) {
      break
    }
    parts.push(data.subarray(lineEnd + 2, lineEnd + 2 + size))
    offset = lineEnd + 2 + size + 2
  }
  return Buffer.concat(parts)
}
