import { JsonRpcPeer, METHOD_NOT_FOUND, MethodError } from "./rpc"
import { openWebSocket, type CloseEvent, type ConnectTiming } from "./ws"

/** The only ACP version that the spawner speaks (`AIR_CLOUD_PROTOCOL_VERSION`). */
export const ACP_PROTOCOL_VERSION = 1

/** The timeout of every request except `session/prompt` and `session/load` (`AcpRequestTimeout.kt`). */
export const REQUEST_TIMEOUT_MS = 60_000

/** The spawner holds a `session/load` response while the environment starts, up to 30 min (`AirCloudAcp.kt`). */
export const LOAD_TIMEOUT_MS = 35 * 60_000

/** The spawner records the name as `launchedFrom`, so the traffic of the tank stays separate from Air. */
export const CLIENT_INFO = { name: "jcp-tank", version: "0.1.0", title: "JCP Tank" } as const

/** The capabilities of `airCloudClientCapabilities()`, so the spawner takes the same code paths as for Air. */
export const CLIENT_CAPABILITIES = {
  terminal: false,
  planCapabilities: {},
  elicitation: { form: {} },
  _meta: {
    "mermaid-rendering": true,
    "subagent-transcript": true,
    jetbrains: { air: { version: 1, capabilities: ["sessionFailure", "recommendedValue", "nativeSubagentSessions"] } },
  },
} as const

/** A `session/update` notification. */
export interface SessionUpdate {
  readonly sessionId: string
  readonly update: Readonly<Record<string, unknown>>
  readonly meta?: Readonly<Record<string, unknown>>
}

/** The repository and the branch that a cloud run clones. */
export interface RemoteTarget {
  readonly url: string
  readonly branch: string
}

/**
 * How the client answers `session/request_permission`. In Air a person answers it. `deny` cancels every
 * request. `allow` selects the "allow once" option, so the agent can run the command of the turn.
 */
export type PermissionPolicy = "allow" | "deny"

export interface AcpClientOptions {
  readonly onUpdate?: (update: SessionUpdate) => void
  readonly onNotification?: (method: string, params: unknown) => void
  readonly onFrame?: (direction: "in" | "out", text: string) => void
  readonly onClose?: (event: CloseEvent) => void
  /** Sees every permission request and the answer that the policy chose. */
  readonly onPermission?: (params: unknown, answer: unknown) => void
  readonly permissions?: PermissionPolicy
  readonly connectTimeoutMs?: number
}

/**
 * An ACP client of the agent spawner. It speaks the wire protocol of `AirCloudAcpConnection`: the org token
 * goes in the handshake and in `_meta.jcpToken` of `session/new`, `session/load`, `session/resume`, and
 * `session/prompt`. The spawner serves one session per connection.
 */
export class AcpClient {
  private constructor(
    private readonly peer: JsonRpcPeer,
    readonly timing: ConnectTiming,
    readonly responseHeaders: Readonly<Record<string, string>>,
  ) {}

  static async connect(url: string, token: string, options: AcpClientOptions = {}): Promise<AcpClient> {
    const peer = new JsonRpcPeer({
      onNotification: (method, params) => {
        const update = asSessionUpdate(method, params)
        if (update === undefined) {
          options.onNotification?.(method, params)
        }
        else {
          options.onUpdate?.(update)
        }
      },
      onRequest: (method, params) => {
        const answer = answerAgentRequest(method, params, options.permissions ?? "deny")
        if (method === "session/request_permission") {
          options.onPermission?.(params, answer)
        }
        return answer
      },
      onFrame: options.onFrame,
      onClose: options.onClose,
    })
    const opened = await openWebSocket(url, peer, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": `${CLIENT_INFO.name}/${CLIENT_INFO.version}` },
      timeoutMs: options.connectTimeoutMs ?? 30_000,
    })
    peer.attach(opened.connection)
    return new AcpClient(peer, opened.timing, opened.responseHeaders)
  }

  initialize(): Promise<Record<string, unknown>> {
    return this.peer.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: CLIENT_INFO,
    }, REQUEST_TIMEOUT_MS)
  }

  /** Creates a draft. The draft has no environment until its first prompt. */
  newSession(remote: RemoteTarget, jcpToken: string): Promise<Record<string, unknown>> {
    return this.peer.request("session/new", {
      cwd: "",
      mcpServers: [],
      _meta: { jcpToken, remote: { url: remote.url, branch: remote.branch } },
    }, REQUEST_TIMEOUT_MS)
  }

  setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<Record<string, unknown>> {
    const params = typeof value === "boolean" ? { sessionId, configId, type: "boolean", value } : { sessionId, configId, value }
    return this.peer.request("session/set_config_option", params, REQUEST_TIMEOUT_MS)
  }

  /** Sends a prompt. The first prompt of a draft launches its environment, so the request has no timeout. */
  prompt(sessionId: string, text: string, jcpToken: string): Promise<Record<string, unknown>> {
    return this.peer.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
      _meta: { jcpToken, jetbrains: { displayText: text } },
    }, 0)
  }

  /**
   * Attaches to an existing session. The spawner replays the history as `session/update` notifications. The
   * `_meta.lastRequestStillInFlight` flag of the result tells whether a turn is still running.
   */
  loadSession(sessionId: string, jcpToken: string): Promise<Record<string, unknown>> {
    return this.peer.request("session/load", { sessionId, cwd: "", mcpServers: [], _meta: { jcpToken } }, LOAD_TIMEOUT_MS)
  }

  /** One page of the sessions of the workspace. The spawner needs no session on the connection for this. */
  listSessions(cursor?: string): Promise<Record<string, unknown>> {
    return this.peer.request("session/list", cursor === undefined ? {} : { cursor }, REQUEST_TIMEOUT_MS)
  }

  /** Stops the current turn. The spawner ignores `$/cancel_request`, so this is the only way. */
  cancel(sessionId: string): void {
    this.peer.notify("session/cancel", { sessionId })
  }

  close(): void {
    this.peer.close()
  }
}

/**
 * Answers a request from the agent. A permission request follows the policy. An elicitation is declined.
 * `fs/*` and `terminal/*` get "method not found", because the client does not offer them.
 */
export function answerAgentRequest(method: string, params: unknown, permissions: PermissionPolicy): unknown {
  switch (method) {
    case "session/request_permission": {
      const options = isRecord(params) && Array.isArray(params.options) ? params.options.filter(isRecord) : []
      const allow = options.find((option) => option.kind === "allow_once") ?? options.find((option) => option.kind === "allow_always")
      return permissions === "allow" && allow !== undefined
        ? { outcome: { outcome: "selected", optionId: allow.optionId } }
        : { outcome: { outcome: "cancelled" } }
    }
    case "elicitation/create":
      return { action: "decline" }
    default:
      throw new MethodError(METHOD_NOT_FOUND, `The client does not implement ${method}`)
  }
}

function asSessionUpdate(method: string, params: unknown): SessionUpdate | undefined {
  if (method !== "session/update" || !isRecord(params) || typeof params.sessionId !== "string" || !isRecord(params.update)) {
    return undefined
  }
  return { sessionId: params.sessionId, update: params.update, meta: isRecord(params._meta) ? params._meta : undefined }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
