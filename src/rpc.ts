import type { CloseEvent, WebSocketConnection, WebSocketHandlers } from "./ws"

export const METHOD_NOT_FOUND = -32601
export const INTERNAL_ERROR = -32603

export interface JsonRpcErrorObject {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

/** The remote side answered a request with an error. */
export class JsonRpcError extends Error {
  override readonly name = "JsonRpcError"

  constructor(readonly method: string, readonly error: JsonRpcErrorObject) {
    super(`${method} failed with JSON-RPC error ${error.code}: ${error.message}`)
  }
}

/** No response came within the timeout of the request. */
export class RequestTimeoutError extends Error {
  override readonly name = "RequestTimeoutError"

  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`${method} got no response within ${timeoutMs} ms`)
  }
}

/** The connection ended before the response came. */
export class ConnectionClosedError extends Error {
  override readonly name = "ConnectionClosedError"

  constructor(readonly method: string, readonly event: CloseEvent) {
    super(`The connection closed before ${method} got a response: ${describeClose(event)}`)
  }
}

/** Thrown by a request handler to answer with this JSON-RPC error. */
export class MethodError extends Error {
  override readonly name = "MethodError"

  constructor(readonly code: number, message: string) {
    super(message)
  }
}

export interface PeerHandlers {
  onNotification(method: string, params: unknown): void
  /** Answers a request from the remote side. Throw a `MethodError` to answer with an error. */
  onRequest(method: string, params: unknown): unknown
  /** Sees every message in both directions, before it is parsed or after it is encoded. */
  onFrame?(direction: "in" | "out", text: string): void
  onClose?(event: CloseEvent): void
}

interface Pending {
  readonly method: string
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout> | undefined
}

/**
 * A JSON-RPC 2.0 peer over a WebSocket: one message per text frame, as in the Air transport. Both sides can
 * send requests. The peer handles the frames of the connection, so it exists before the connection does.
 */
export class JsonRpcPeer implements WebSocketHandlers {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private connection: WebSocketConnection | undefined
  private closeEvent: CloseEvent | undefined

  constructor(private readonly handlers: PeerHandlers) {}

  attach(connection: WebSocketConnection): void {
    this.connection = connection
  }

  /** Sends a request. A timeout of 0 waits without a limit, as Air does for `session/prompt`. */
  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.closeEvent !== undefined) {
      return Promise.reject(new ConnectionClosedError(method, this.closeEvent))
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id)
          reject(new RequestTimeoutError(method, timeoutMs))
        }, timeoutMs)
        : undefined
      this.pending.set(id, { method, resolve: resolve as (result: unknown) => void, reject, timer })
      try {
        this.send({ jsonrpc: "2.0", id, method, params })
      }
      catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e as Error)
      }
    })
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params })
  }

  close(): void {
    this.connection?.close(1000)
  }

  /** Drops the connection with no close frame. */
  abort(): void {
    this.connection?.abort()
  }

  onText(text: string): void {
    this.handlers.onFrame?.("in", text)
    let message: Record<string, unknown>
    try {
      message = JSON.parse(text) as Record<string, unknown>
    }
    catch {
      return
    }
    if (typeof message.method === "string") {
      if (message.id === undefined || message.id === null) {
        this.handlers.onNotification(message.method, message.params)
      }
      else {
        void this.answer(message.id, message.method, message.params)
      }
      return
    }
    if (typeof message.id !== "number") {
      return
    }
    const pending = this.pending.get(message.id)
    if (pending === undefined) {
      // A response that came after its timeout.
      return
    }
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error !== undefined) {
      pending.reject(new JsonRpcError(pending.method, message.error as JsonRpcErrorObject))
    }
    else {
      pending.resolve(message.result)
    }
  }

  onClose(event: CloseEvent): void {
    this.closeEvent = event
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(new ConnectionClosedError(pending.method, event))
    }
    this.handlers.onClose?.(event)
  }

  private async answer(id: unknown, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.handlers.onRequest(method, params)
      this.send({ jsonrpc: "2.0", id, result: result ?? null })
    }
    catch (e) {
      const code = e instanceof MethodError ? e.code : INTERNAL_ERROR
      this.send({ jsonrpc: "2.0", id, error: { code, message: (e as Error).message } })
    }
  }

  private send(message: Record<string, unknown>): void {
    const connection = this.connection
    if (connection === undefined) {
      throw new Error("The peer has no connection")
    }
    const text = JSON.stringify(message)
    this.handlers.onFrame?.("out", text)
    connection.sendText(text)
  }
}

export function describeClose(event: CloseEvent): string {
  if (event.error !== undefined) {
    return event.error.message
  }
  const who = event.byClient ? "the client" : "the server"
  return `${who} closed it with code ${event.code ?? "none"}${event.reason === "" ? "" : ` (${event.reason})`}`
}
