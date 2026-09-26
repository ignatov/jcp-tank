import { randomBytes } from "node:crypto"
import { AcpClient, isRecord, type PermissionPolicy, type RemoteTarget, type SessionUpdate } from "./acp"
import { describeClose } from "./rpc"
import type { RunLog } from "./run-log"
import type { SpawnerHttp } from "./spawner"
import type { ConnectTiming } from "./ws"

/** What happens to the session after its turns: `archive` terminates it and keeps the history, `delete` removes it. */
export type Cleanup = "archive" | "delete" | "none"

/** A config option to set before the first prompt. `key` is a config id or a category (`model`, `mode`, ...). */
export interface Setting {
  readonly key: string
  readonly value: string
}

/** What the run learned about the environment. A turn check can use it. */
export interface RunFacts {
  /** The commit that the environment cloned (`session_info_update._meta.remote.revision`). */
  readonly revision?: string
}

/** One prompt of a run. The unique marker in the answer proves that the agent answered this prompt. */
export interface TurnSpec {
  /** `cold` for the first prompt, which launches the environment, and `warm` for a later one. */
  readonly name: string
  readonly prompt: (marker: string) => string
  /** A check of the answer beyond the marker. It returns the reason of a failure, or `undefined`. */
  readonly check?: (answer: string, facts: RunFacts) => string | undefined
}

export type Outcome = "ok" | "no-marker" | "check-failed" | "refused" | "failed" | "timeout" | "aborted"

/** One prompt and its answer. The times are milliseconds since the start of the run. */
export interface TurnResult {
  readonly name: string
  readonly marker: string
  promptSent?: number
  firstUpdate?: number
  markerAt?: number
  turnEnd?: number
  stopReason?: string
  outcome?: Outcome
  error?: string
  /** The start of the answer, for a failure analysis. */
  answer?: string
  /** The permission requests of the turn. The policy of the run answered them. */
  permissions: number
}

/** Receives the progress of a run, for a live view. */
export interface RunObserver {
  onSession?(sessionId: string): void
  /** A local step (`connecting`, `draft`, `warm turn`, `archiving`) or a spawner status (`LAUNCHING`, `RUNNING`). */
  onState?(state: string): void
  onTurnEnd?(turn: TurnResult): void
}

export interface LaunchOptions {
  readonly acpUrl: string
  readonly spawner: SpawnerHttp
  readonly token: string
  readonly remote: RemoteTarget
  /** Applied in order, each one before the first prompt, like the options of the Air composer. */
  readonly settings: readonly Setting[]
  readonly turns: readonly TurnSpec[]
  /** The limit of one turn. The spawner allows 30 min for a launch, and Air waits 35 min (`AirCloudAcp.kt`). */
  readonly turnTimeoutMs: number
  readonly cleanup: Cleanup
  readonly permissions: PermissionPolicy
  readonly log: RunLog
  readonly progress?: (line: string) => void
  readonly observer?: RunObserver
  readonly signal?: AbortSignal
  /** Copied into the result, for example the batch id and the index in the batch. */
  readonly tags?: Readonly<Record<string, unknown>>
}

/** The milliseconds since the start of the run at which each control-plane step ended. */
export interface LaunchPhases {
  connected?: number
  initialized?: number
  sessionNew?: number
  configured?: number
  cleaned?: number
}

export interface CleanupResult {
  readonly action: Cleanup
  readonly status?: number
  readonly ms?: number
  /** The status of the session after the cleanup, for example `ARCHIVED`. */
  readonly finalStatus?: string
  readonly error?: string
}

/** One line of `runs/launches.jsonl`. The report computes every statistic from these lines. */
export interface LaunchResult {
  readonly runId: string
  readonly startedAt: string
  readonly tags?: Readonly<Record<string, unknown>>
  readonly remote: RemoteTarget
  readonly settings: readonly Setting[]
  readonly sessionId?: string
  readonly outcome: Outcome
  readonly error?: string
  readonly phases: LaunchPhases
  /**
   * Each change of the spawner status (`session_info_update._meta.status`), in milliseconds since the start:
   * `DRAFT`, `LAUNCHING`, `CLONING_REPOSITORY`, `STARTING_CONTAINER`, `LAUNCHING` of the agent, `RUNNING`, ...
   */
  readonly statuses: readonly { readonly status: string, readonly at: number }[]
  readonly turns: readonly TurnResult[]
  readonly revision?: string
  readonly connect?: ConnectTiming
  readonly updates: number
  readonly cleanup?: CleanupResult
}

class AbortedError extends Error {}

class TurnTimeoutError extends Error {}

/**
 * One cloud run, the way Air starts it: `session/new`, the config options, then the prompts. The first prompt
 * launches the environment. Each prompt asks for a unique marker, and the marker in the answer proves that the
 * agent answered. The run stops at the first failed turn, then cleans up the session.
 */
export async function launch(options: LaunchOptions): Promise<LaunchResult> {
  const runId = randomBytes(4).toString("hex")
  const startedAt = new Date().toISOString()
  const started = performance.now()
  const now = () => Math.round(performance.now() - started)
  const say = (line: string) => options.progress?.(line)
  const state = (value: string) => options.observer?.onState?.(value)
  const phases: LaunchPhases = {}
  const statuses: { status: string, at: number }[] = []
  const turns: TurnResult[] = []
  const facts: { revision?: string } = {}
  let sessionId: string | undefined
  let sniffedSessionId: string | undefined
  let promptStarted = false
  let updates = 0
  let failure: string | undefined
  let current: { turn: TurnResult, answer: string, complete: PromiseWithResolvers<void> } | undefined
  let client: AcpClient | undefined
  const base = { runId, startedAt, tags: options.tags, remote: options.remote, settings: options.settings }

  if (isAborted(options.signal)) {
    return { ...base, outcome: "aborted", error: "The batch was aborted before this run started", phases, statuses, turns, updates }
  }
  options.log.event("launch", { ...base })

  const onUpdate = (update: SessionUpdate) => {
    const body = update.update
    const kind = String(body.sessionUpdate ?? "?")
    // The spawner sends the `session_info_update` of every session of the workspace to every connection.
    // Only an update of this session counts, and a status update never names the draft of a failed session/new.
    if (sessionId === undefined ? kind === "session_info_update" : update.sessionId !== sessionId) {
      return
    }
    sniffedSessionId ??= update.sessionId
    updates++
    const text = isRecord(body.content) && typeof body.content.text === "string" ? body.content.text : undefined
    const info = kind === "session_info_update" && isRecord(body._meta) ? body._meta : undefined
    const status = typeof info?.status === "string" ? info.status : undefined
    const revision = isRecord(info?.remote) && typeof info.remote.revision === "string" && info.remote.revision !== "" ? info.remote.revision : undefined
    facts.revision = revision ?? facts.revision
    if (status !== undefined && status !== statuses.at(-1)?.status) {
      statuses.push({ status, at: now() })
      state(status)
    }
    const turn = current
    if (turn !== undefined) {
      turn.turn.firstUpdate ??= now()
      const since = `  +${now() - (turn.turn.promptSent ?? 0)} ms`
      if (status !== undefined) {
        say(`${since} status ${status}`)
      }
      else if (kind !== "session_info_update" && kind !== "usage_update") {
        say(`${since} ${kind}${text === undefined || text === "" ? "" : `: ${JSON.stringify(text.slice(0, 160))}`}`)
      }
      if (kind === "agent_message_chunk" && text !== undefined) {
        turn.answer += text
        if (turn.turn.markerAt === undefined && turn.answer.includes(turn.turn.marker)) {
          turn.turn.markerAt = now()
          say(`  marker received after ${turn.turn.markerAt - (turn.turn.promptSent ?? 0)} ms`)
        }
      }
    }
    const air = isRecord(update.meta?.jetbrains) && isRecord(update.meta.jetbrains.air) ? update.meta.jetbrains.air : undefined
    if (isRecord(air?.sessionFailure)) {
      failure = `sessionFailure: ${JSON.stringify(air.sessionFailure).slice(0, 300)}`
      say(`  ${failure}`)
    }
    if (update.meta?.lastRequestComplete === true) {
      turn?.complete.resolve()
    }
  }

  let controlError: { outcome: Outcome, error: string } | undefined
  try {
    state("connecting")
    client = await AcpClient.connect(options.acpUrl, options.token, {
      onUpdate,
      permissions: options.permissions,
      onPermission: (_, answer) => {
        if (current !== undefined) {
          current.turn.permissions++
        }
        say(`  permission requested; answered ${JSON.stringify(answer)}`)
      },
      onFrame: (direction, text) => options.log.frame(direction, text),
      onClose: (event) => options.log.event("close", { close: describeClose(event) }),
    })
    phases.connected = now()
    say(`connect      ${phases.connected} ms`)
    await client.initialize()
    phases.initialized = now()
    const created = await client.newSession(options.remote, options.token)
    if (typeof created.sessionId !== "string") {
      throw new Error("session/new returned no sessionId")
    }
    sessionId = created.sessionId
    phases.sessionNew = now()
    options.observer?.onSession?.(sessionId)
    state("draft")
    say(`session/new  ${phases.sessionNew - phases.initialized} ms, session ${sessionId}`)
    let configOptions: unknown = created.configOptions
    for (const setting of options.settings) {
      const configId = resolveConfigId(configOptions, setting)
      configOptions = (await client.setConfigOption(sessionId, configId, setting.value)).configOptions ?? configOptions
      say(`set          ${configId}=${setting.value}`)
    }
    phases.configured = now()

    for (const [index, spec] of options.turns.entries()) {
      if (isAborted(options.signal)) {
        throw new AbortedError("The run was aborted")
      }
      const turn: TurnResult = { name: spec.name, marker: `MARKER-${runId}-${index + 1}`, permissions: 0 }
      turns.push(turn)
      current = { turn, answer: "", complete: Promise.withResolvers<void>() }
      if (index > 0) {
        state(`${spec.name} turn`)
      }
      promptStarted = true
      turn.promptSent = now()
      say(index === 0 ? `prompt       ${spec.name}: sent; the environment starts now` : `prompt       ${spec.name}: sent`)
      const response = client.prompt(sessionId, spec.prompt(turn.marker), options.token)
      try {
        const ended = await raceTurn(response, current.complete.promise, options.turnTimeoutMs, options.signal)
        turn.turnEnd = now()
        turn.stopReason = ended.stopReason
        turn.answer = current.answer.slice(0, 500)
        Object.assign(turn, judgeTurn(turn, current.answer, spec, facts, failure))
        say(`turn end     ${spec.name}: ${turn.turnEnd - turn.promptSent} ms, ${ended.stopReason ?? "lastRequestComplete"}, ${turn.outcome}`)
      }
      catch (e) {
        turn.outcome = e instanceof AbortedError ? "aborted" : e instanceof TurnTimeoutError ? "timeout" : "failed"
        turn.error = (e as Error).message
        turn.answer = current.answer.slice(0, 500)
        say(`error        ${turn.error}`)
        if (turn.outcome !== "failed") {
          client.cancel(sessionId)
        }
      }
      current = undefined
      options.observer?.onTurnEnd?.(turn)
      if (turn.outcome !== "ok") {
        break
      }
    }
  }
  catch (e) {
    controlError = { outcome: e instanceof AbortedError ? "aborted" : "failed", error: (e as Error).message }
    say(`error        ${controlError.error}`)
  }

  const target = sessionId ?? sniffedSessionId
  let cleanup: CleanupResult | undefined
  if (target !== undefined) {
    // A draft whose first prompt never started has no environment: delete it, as Air does.
    const action: Cleanup = promptStarted ? options.cleanup : "delete"
    state(action === "none" ? "left running" : `${action === "archive" ? "archiving" : "deleting"}`)
    cleanup = await cleanUp(options.spawner, target, action, say)
    phases.cleaned = now()
    options.log.event("cleanup", { sessionId: target, ...cleanup })
  }
  client?.close()
  const failedTurn = turns.find((turn) => turn.outcome !== "ok")
  const outcome: Outcome = controlError?.outcome ?? failedTurn?.outcome ?? "ok"
  const result: LaunchResult = {
    ...base,
    sessionId: target,
    outcome,
    error: controlError?.error ?? failedTurn?.error,
    phases,
    statuses,
    turns,
    revision: facts.revision,
    connect: client?.timing,
    updates,
    cleanup,
  }
  state(outcome === "ok" ? cleanup?.finalStatus ?? "done" : outcome)
  options.log.event("result", { ...result })
  return result
}

/** Reads the signal through a call, because the signal changes between two awaits of the run. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function judgeTurn(turn: TurnResult, answer: string, spec: TurnSpec, facts: RunFacts, failure: string | undefined): Pick<TurnResult, "outcome" | "error"> {
  if (turn.stopReason === "refusal") {
    return { outcome: "refused", error: `refusal: ${answer.slice(0, 300)}` }
  }
  if (turn.markerAt === undefined) {
    return failure !== undefined
      ? { outcome: "failed", error: failure }
      : { outcome: "no-marker", error: `The answer has no marker: ${JSON.stringify(answer.slice(0, 300))}` }
  }
  const problem = spec.check?.(answer, facts)
  return problem === undefined ? { outcome: "ok" } : { outcome: "check-failed", error: problem }
}

async function raceTurn(
  turn: Promise<Record<string, unknown>>,
  lastRequestComplete: Promise<void>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ stopReason?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TurnTimeoutError(`The turn did not end within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)
    onAbort = () => reject(new AbortedError("The run was aborted"))
    if (signal?.aborted === true) {
      onAbort()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([
      turn.then((response) => ({ stopReason: typeof response.stopReason === "string" ? response.stopReason : undefined })),
      lastRequestComplete.then(() => ({})),
      guard,
    ])
  }
  finally {
    clearTimeout(timer)
    if (onAbort !== undefined) {
      signal?.removeEventListener("abort", onAbort)
    }
  }
}

async function cleanUp(spawner: SpawnerHttp, sessionId: string, action: Cleanup, say: (line: string) => void): Promise<CleanupResult> {
  if (action === "none") {
    say(`cleanup      none; the session ${sessionId} keeps running until the spawner stops it`)
    return { action }
  }
  try {
    const outcome = action === "archive" ? await spawner.archiveSession(sessionId) : await spawner.deleteSession(sessionId)
    let finalStatus: string | undefined
    if (action === "archive" && outcome.status >= 200 && outcome.status < 300) {
      const status = await spawner.sessionStatus(sessionId)
      finalStatus = parseStatus(status.body)
    }
    say(`cleanup      ${action}: HTTP ${outcome.status} in ${outcome.ms} ms${finalStatus === undefined ? "" : `, status ${finalStatus}`}`)
    return { action, status: outcome.status, ms: outcome.ms, finalStatus }
  }
  catch (e) {
    say(`cleanup      ${action} failed: ${(e as Error).message}`)
    return { action, error: (e as Error).message }
  }
}

function parseStatus(body: string): string | undefined {
  try {
    const value: unknown = JSON.parse(body)
    return typeof value === "string" ? value : undefined
  }
  catch {
    return body.trim() === "" ? undefined : body.trim()
  }
}

/** The config id for a setting: an option with that id, else the option of that category, as Air matches them. */
export function resolveConfigId(configOptions: unknown, setting: Setting): string {
  const options = Array.isArray(configOptions) ? configOptions.filter(isRecord) : []
  const option = options.find((o) => o.id === setting.key) ?? options.find((o) => o.category === setting.key)
  if (option === undefined) {
    throw new Error(`The draft has no config option "${setting.key}". It has: ${options.map((o) => String(o.id)).join(", ")}`)
  }
  const values = flattenValues(option.options)
  if (values.length > 0 && !values.includes(setting.value)) {
    throw new Error(`The option ${String(option.id)} has no value "${setting.value}". It has: ${values.join(", ")}`)
  }
  return String(option.id)
}

function flattenValues(options: unknown): string[] {
  if (!Array.isArray(options)) {
    return []
  }
  return options.filter(isRecord).flatMap((entry) => Array.isArray(entry.options) ? flattenValues(entry.options) : [String(entry.value)])
}
