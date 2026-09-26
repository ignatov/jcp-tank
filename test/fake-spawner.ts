import type { Server, ServerWebSocket } from "bun"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isRecord } from "../src/acp"
import type { LaunchOptions } from "../src/launch"
import { RunLog } from "../src/run-log"
import { SpawnerHttp } from "../src/spawner"
import { COLD_TURN } from "../src/turns"

type Message = Record<string, any>
type Connection = { sessionId?: string, prompts: number, pending: Map<string, (result: unknown) => void> }

/** How the fake answers a prompt. */
export type PromptBehavior = "answer" | "refuse" | "silent" | "lastRequestComplete"

/** The commit that the fake environment "clones". */
export const REVISION = "895d70d934b0fb07f5a33b65c825203b2714e345"

export const CONFIG_OPTIONS = [
  { id: "_agent", category: "agent", currentValue: "codex", options: [{ value: "codex" }, { value: "claude" }] },
  { id: "model", category: "model", currentValue: "gpt-6-sol", options: [{ value: "gpt-6-sol" }, { value: "gpt-6-luna" }] },
  { id: "reasoning_effort", category: "thought_level", currentValue: "medium", options: [{ value: "low" }, { value: "medium" }] },
  { id: "mode", category: "mode", currentValue: "agent-full-access", options: [{ value: "read-only" }, { value: "agent-full-access" }] },
]

/**
 * A fake agent spawner. Each connection gets its own session id. The first prompt of a session walks the
 * statuses of a launch, as the production spawner does. A prompt that asks for `git rev-parse` first asks
 * the client for a permission, and answers with the commit only when the client allows it.
 */
export class FakeSpawner {
  behavior: PromptBehavior = "answer"
  /** The production spawner sends the status updates of every session of the workspace to every connection. */
  broadcastStatuses = true
  private readonly connections = new Set<ServerWebSocket<Connection>>()
  /** The requests of every connection: `initialize`, `session/new`, `set <id>=<value>`, `session/prompt`, ... */
  readonly methods: string[] = []
  readonly http: string[] = []
  readonly permissionAnswers: unknown[] = []
  private sessions = 0
  private permissionRequests = 0
  readonly server: Server<Connection>

  constructor() {
    this.server = Bun.serve<Connection>({
      port: 0,
      fetch: (request, bun) => {
        const url = new URL(request.url)
        if (url.pathname === "/agent-spawner/acp") {
          return bun.upgrade(request, { data: { prompts: 0, pending: new Map() } }) ? undefined : new Response("", { status: 400 })
        }
        const path = url.pathname.replace("/agent-spawner", "")
        this.http.push(`${request.method} ${path}`)
        return path.endsWith("/status") ? new Response("\"ARCHIVED\"") : new Response(null, { status: 200 })
      },
      websocket: {
        open: (ws) => void this.connections.add(ws),
        close: (ws) => void this.connections.delete(ws),
        message: (ws, data) => void this.handle(ws, JSON.parse(String(data)) as Message),
      },
    })
  }

  async options(overrides: Partial<LaunchOptions> = {}): Promise<LaunchOptions> {
    const base = `127.0.0.1:${this.server.port}/agent-spawner`
    return {
      acpUrl: `ws://${base}/acp`,
      spawner: new SpawnerHttp(`http://${base}`, async () => "token"),
      token: "token",
      remote: { url: "https://github.com/ignatov/intellij-erlang.git", branch: "master" },
      settings: [{ key: "_agent", value: "codex" }, { key: "model", value: "gpt-6-luna" }, { key: "thought_level", value: "low" }, { key: "mode", value: "read-only" }],
      turns: [COLD_TURN],
      turnTimeoutMs: 5000,
      cleanup: "archive",
      permissions: "allow",
      log: await RunLog.create("test", await this.directory()),
      ...overrides,
    }
  }

  directory(): Promise<string> {
    return mkdtemp(join(tmpdir(), "jcp-tank-test-"))
  }

  stop(): void {
    void this.server.stop(true)
  }

  private async handle(ws: ServerWebSocket<Connection>, message: Message): Promise<void> {
    if (message.method === undefined && message.id !== undefined) {
      this.permissionAnswers.push(message.result)
      ws.data.pending.get(String(message.id))?.(message.result)
      return
    }
    this.methods.push(message.method === "session/set_config_option" ? `set ${message.params.configId}=${message.params.value}` : message.method)
    const send = (payload: unknown) => ws.send(JSON.stringify(payload))
    const reply = (result: unknown) => send({ jsonrpc: "2.0", id: message.id, result })
    const update = (body: unknown, meta?: unknown) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: ws.data.sessionId, update: body, _meta: meta } })
    const chunk = (text: string, meta?: unknown) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, meta)
    const status = (value: string, revision: string = "") => {
      const text = JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: ws.data.sessionId,
          update: { sessionUpdate: "session_info_update", _meta: { status: value, remote: { url: "https://github.com/ignatov/intellij-erlang", branch: "master", revision } } },
        },
      })
      for (const connection of this.broadcastStatuses ? this.connections : [ws]) {
        connection.send(text)
      }
    }
    switch (message.method) {
      case "initialize":
        reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } })
        return
      case "session/new":
        ws.data.sessionId = `s-${++this.sessions}`
        reply({ sessionId: ws.data.sessionId, configOptions: CONFIG_OPTIONS })
        return
      case "session/set_config_option":
        reply({ configOptions: CONFIG_OPTIONS })
        return
      case "session/prompt": {
        const text = String(message.params.prompt[0].text)
        const marker = /MARKER-[0-9a-f]+-\d+/.exec(text)?.[0] ?? "none"
        ws.data.prompts++
        if (this.behavior === "silent") {
          return
        }
        if (this.behavior === "refuse") {
          chunk("Read access to `ignatov/intellij-erlang` is required")
          reply({ stopReason: "refusal" })
          return
        }
        if (ws.data.prompts === 1) {
          status("LAUNCHING")
          chunk("Cloning repository...\n\n")
          status("CLONING_REPOSITORY")
          status("STARTING_CONTAINER")
          status("LAUNCHING")
          status("RUNNING", REVISION)
        }
        let answer = `Fine, ${marker}.`
        if (text.includes("git rev-parse")) {
          answer = await this.askPermission(ws) ? `${REVISION}\n${marker}` : `I could not run the command. ${marker}`
        }
        if (this.behavior === "lastRequestComplete") {
          chunk(answer)
          chunk("", { lastRequestComplete: true })
          return
        }
        chunk(answer)
        reply({ stopReason: "end_turn" })
        status("FINISHED", REVISION)
      }
    }
  }

  private askPermission(ws: ServerWebSocket<Connection>): Promise<boolean> {
    const id = `perm-${++this.permissionRequests}`
    return new Promise((resolve) => {
      ws.data.pending.set(id, (result) => resolve(isRecord(result) && isRecord(result.outcome) && result.outcome.optionId === "allow"))
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "session/request_permission",
        params: {
          sessionId: ws.data.sessionId,
          toolCall: { toolCallId: "t-1", title: "git rev-parse HEAD", kind: "execute" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }],
        },
      }))
    })
  }
}
