import { createInterface } from "node:readline"
import { AcpClient, isRecord, type RemoteTarget, type SessionUpdate } from "./acp"
import { resolveConfigId, type Setting } from "./launch"
import { describeClose } from "./rpc"
import type { RunLog } from "./run-log"
import type { SpawnerHttp } from "./spawner"

/** A new session on a repository, or an existing session by its id. */
export type ChatTarget =
  | { readonly kind: "new", readonly remote: RemoteTarget, readonly settings: readonly Setting[] }
  | { readonly kind: "attach", readonly sessionId: string }

export interface ChatOptions {
  readonly acpUrl: string
  readonly spawner: SpawnerHttp
  readonly token: string
  readonly target: ChatTarget
  readonly webUrl: (sessionId: string) => string
  readonly log: RunLog
  readonly input: NodeJS.ReadableStream
  readonly write: (text: string) => void
  /** True for a terminal: the chat then shows a prompt, and Ctrl-C cancels the turn. */
  readonly terminal: boolean
}

const HELP = "Commands: /cancel stops the turn, /status shows the session, /web shows the link, /archive ends the session, /quit leaves it running."

/**
 * An interactive session: each line is a prompt, and the answer streams in. The first prompt of a new
 * session launches its environment. Leaving the chat keeps the session, so `chat --session <id>` can attach
 * to it again. A draft without a prompt has no environment, and the chat deletes it on exit, as Air does.
 */
export async function chat(options: ChatOptions): Promise<void> {
  const transcript = new Transcript(options.write)
  let sessionId: string | undefined
  let promptSent = options.target.kind === "attach"
  let archived = false
  let turn: PromiseWithResolvers<string | undefined> | undefined

  const client = await AcpClient.connect(options.acpUrl, options.token, {
    onFrame: (direction, text) => options.log.frame(direction, text),
    onUpdate: (update) => {
      // Every connection gets the status updates of every session of the workspace.
      if (sessionId === undefined ? update.update.sessionUpdate === "session_info_update" : update.sessionId !== sessionId) {
        return
      }
      transcript.update(update)
      if (update.meta?.lastRequestComplete === true) {
        turn?.resolve(undefined)
      }
    },
    onClose: (event) => {
      options.log.event("close", { close: describeClose(event) })
      transcript.line(`[connection closed: ${describeClose(event)}]`)
    },
  })
  try {
    await client.initialize()
    if (options.target.kind === "new") {
      const created = await client.newSession(options.target.remote, options.token)
      if (typeof created.sessionId !== "string") {
        throw new Error("session/new returned no sessionId")
      }
      sessionId = created.sessionId
      let configOptions: unknown = created.configOptions
      for (const setting of options.target.settings) {
        const configId = resolveConfigId(configOptions, setting)
        configOptions = (await client.setConfigOption(sessionId, configId, setting.value)).configOptions ?? configOptions
      }
      const chosen = options.target.settings.map((s) => `${s.key}=${s.value}`).join(", ")
      transcript.line(`[session] ${sessionId}: a draft${chosen === "" ? "" : ` (${chosen})`}. The first message starts the environment.`)
    }
    else {
      sessionId = options.target.sessionId
      const status = await options.spawner.sessionStatus(sessionId)
      const parsed = parseJson(status.body)
      transcript.status = typeof parsed === "string" ? parsed : undefined
      transcript.line(`[session] ${sessionId}: status ${status.body || `HTTP ${status.status}`}. Loading the history...`)
      const loaded = await client.loadSession(sessionId, options.token)
      const inFlight = isRecord(loaded._meta) && loaded._meta.lastRequestStillInFlight === true
      transcript.line(inFlight ? "[a turn is running; its output follows]" : "[history loaded]")
    }
    transcript.line(`[web] ${options.webUrl(sessionId)}`)
    transcript.line(HELP)

    const current = sessionId
    const rl = createInterface({ input: options.input, output: options.terminal ? process.stdout : undefined, terminal: options.terminal })
    rl.setPrompt("you> ")
    const showPrompt = () => {
      if (options.terminal) {
        rl.prompt()
      }
    }
    rl.on("SIGINT", () => {
      if (turn === undefined) {
        rl.close()
        return
      }
      client.cancel(current)
      transcript.line("[cancel sent]")
    })

    const runTurn = async (text: string) => {
      turn = Promise.withResolvers<string | undefined>()
      transcript.newTurn()
      if (!promptSent) {
        transcript.line("[launching the environment]")
      }
      promptSent = true
      const started = performance.now()
      const pending = turn
      client.prompt(current, text, options.token).then(
        (response) => pending.resolve(typeof response.stopReason === "string" ? response.stopReason : undefined),
        (error: unknown) => pending.reject(error),
      )
      try {
        const stopReason = await pending.promise
        transcript.line(`[turn end: ${stopReason ?? "complete"}, ${((performance.now() - started) / 1000).toFixed(1)} s]`)
      }
      catch (e) {
        transcript.line(`[turn failed: ${(e as Error).message}]`)
      }
      finally {
        turn = undefined
      }
    }

    const command = async (text: string): Promise<boolean> => {
      switch (text.split(/\s+/)[0]) {
        case "/quit":
        case "/exit":
          return true
        case "/cancel":
          client.cancel(current)
          return false
        case "/web":
          transcript.line(`[web] ${options.webUrl(current)}`)
          return false
        case "/status": {
          const outcome = await options.spawner.session(current)
          const session = parseObject(outcome.body)
          transcript.line(`[status] ${String(session?.status ?? `HTTP ${outcome.status}`)}${session?.statusComment === undefined ? "" : `: ${String(session.statusComment)}`}`)
          return false
        }
        case "/archive": {
          const outcome = await options.spawner.archiveSession(current)
          archived = outcome.status >= 200 && outcome.status < 300
          transcript.line(`[archive] HTTP ${outcome.status}`)
          return archived
        }
        default:
          transcript.line(HELP)
          return false
      }
    }

    showPrompt()
    for await (const line of rl) {
      const text = line.trim()
      if (text !== "" && (text.startsWith("/") ? await command(text) : (await runTurn(text), false))) {
        break
      }
      showPrompt()
    }
    rl.close()
  }
  finally {
    if (sessionId !== undefined && !promptSent) {
      const outcome = await options.spawner.deleteSession(sessionId)
      transcript.line(`[draft deleted: HTTP ${outcome.status}]`)
    }
    else if (sessionId !== undefined) {
      const status = archived ? "ARCHIVED" : transcript.status
      transcript.line(status !== undefined && CONCLUDED_STATUSES.has(status)
        ? `[left] The session is ${status}. Its history stays: ./jcp-tank chat --session ${sessionId}`
        : `[left] The session keeps running. Attach: ./jcp-tank chat --session ${sessionId}. End it: ./jcp-tank archive ${sessionId}`)
    }
    client.close()
  }
}

/** The spawner statuses that a session never leaves. An attach then only replays the history. */
const CONCLUDED_STATUSES: ReadonlySet<string> = new Set(["ARCHIVED", "ABORTED"])

/** Renders the updates as a transcript: the agent text inline, the other updates as short tagged lines. */
class Transcript {
  private inline = false
  private thinking = false
  private messageId: string | undefined
  status: string | undefined

  constructor(private readonly write: (text: string) => void) {}

  line(text: string): void {
    if (this.inline) {
      this.write("\n")
      this.inline = false
    }
    this.write(`${text}\n`)
  }

  newTurn(): void {
    this.thinking = false
  }

  update(update: SessionUpdate): void {
    const body = update.update
    const content = body.content
    const text = isRecord(content) && typeof content.text === "string" ? content.text : ""
    switch (body.sessionUpdate) {
      case "agent_message_chunk": {
        // A new message, or a note of the spawner (it has no messageId), starts on a new line.
        const messageId = typeof body.messageId === "string" ? body.messageId : undefined
        if (this.inline && messageId !== this.messageId) {
          this.write("\n")
          this.inline = false
        }
        this.messageId = messageId
        if (text !== "") {
          this.write(text)
          this.inline = !text.endsWith("\n")
        }
        return
      }
      case "user_message_chunk":
        if (text !== "") {
          this.line(`you> ${text}`)
        }
        return
      case "agent_thought_chunk":
        if (!this.thinking) {
          this.thinking = true
          this.line("[thinking]")
        }
        return
      case "tool_call":
        this.line(`[tool] ${String(body.title ?? body.kind ?? "call")}`)
        return
      case "tool_call_update":
        if (body.status === "failed") {
          this.line(`[tool failed] ${String(body.title ?? body.toolCallId ?? "")}`)
        }
        return
      case "session_info_update": {
        const status = isRecord(body._meta) && typeof body._meta.status === "string" ? body._meta.status : undefined
        if (status !== undefined && status !== this.status) {
          this.status = status
          this.line(`[status] ${status}`)
        }
      }
    }
  }
}

function parseObject(text: string): Record<string, unknown> | undefined {
  const value = parseJson(text)
  return isRecord(value) ? value : undefined
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}
