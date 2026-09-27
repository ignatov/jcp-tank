import { AcpClient, isRecord, type SessionUpdate } from "./acp"
import type { RunLog } from "./run-log"
import type { SpawnerHttp } from "./spawner"

/** How a drop ends the connection: a close frame, or a lost network with no close frame. */
export type DropKind = "close" | "abort"

export interface RaceOptions {
  readonly acpUrl: string
  readonly token: string
  readonly http: SpawnerHttp
  readonly repositoryUrl: string
  /** The pauses between the `session/new` request and the drop. */
  readonly delaysMs: readonly number[]
  readonly parallelDrafts: number
  /** How long the spawner gets to finish a `session/new` that lost its connection. */
  readonly settleMs: number
  /** How long after the first check the tool looks at the orphaned drafts again. */
  readonly recheckMs: number
  /** How long the parallel connections stay open after their answers, to time the DRAFT statuses. */
  readonly observeMs: number
  /** Keeps the drafts on the spawner instead of deleting them. */
  readonly keep: boolean
  readonly log: RunLog
  readonly say: (line: string) => void
}

interface DropAttempt {
  readonly kind: DropKind
  readonly delayMs: number
  readonly branch: string
  sentAt?: number
  answeredId?: string
  answeredAfterMs?: number
  error?: string
  draftId?: string
  draftStatus?: string
  listed?: boolean
  inHttpList?: boolean
}

/**
 * Two races on drafts, free because no prompt goes out and no environment starts.
 *
 * The first one drops the connection during `session/new` (IJAI-2701): does the draft stay on the spawner,
 * with no client that knows its ID? Each attempt names its own branch, so the tool finds its draft later. Two
 * paths find a draft: the DRAFT status that an observer connection gets, and `session/list`. The attempts
 * whose answer arrives before the drop check both paths.
 *
 * The second one creates drafts on parallel connections (IJAI-2691): does a status of another draft arrive
 * before the answer to `session/new`? Air takes the first ID it sees in that window as its own draft. The
 * connections then stay open for a while, so the tool can time the DRAFT statuses.
 */
export async function runRaces(options: RaceOptions): Promise<void> {
  const runId = Math.random().toString(16).slice(2, 6)
  options.say(`run         ${runId}`)
  if (options.delaysMs.length > 0) {
    await dropDuringSessionNew(options, runId)
  }
  await parallelDrafts(options, runId)
}

async function dropDuringSessionNew(options: RaceOptions, runId: string): Promise<void> {
  const { log, say } = options
  // Every connection gets the status of every session of the workspace, so this one sees each new draft.
  const draftSeenAt = new Map<string, number>()
  const observer = await AcpClient.connect(options.acpUrl, options.token, {
    onUpdate: (update) => {
      if (update.update.sessionUpdate === "session_info_update" && statusOf(update) === "DRAFT" && !draftSeenAt.has(update.sessionId)) {
        draftSeenAt.set(update.sessionId, performance.now())
        log.event("observer-draft", { sessionId: update.sessionId })
      }
    },
  })
  const attempts: DropAttempt[] = []
  try {
    await observer.initialize()
    let index = 0
    for (const kind of ["abort", "close"] as const) {
      for (const delayMs of options.delaysMs) {
        const attempt: DropAttempt = { kind, delayMs, branch: `jcp-tank-drop-${runId}-${index++}` }
        attempts.push(attempt)
        const client = await AcpClient.connect(options.acpUrl, options.token, { onFrame: (direction, text) => log.frame(direction, text) })
        await client.initialize()
        const sentAt = performance.now()
        attempt.sentAt = sentAt
        const pending = client.newSession({ url: options.repositoryUrl, branch: attempt.branch }, options.token)
          .then((result) => {
            attempt.answeredId = typeof result.sessionId === "string" ? result.sessionId : "?"
            attempt.answeredAfterMs = Math.round(performance.now() - sentAt)
          })
          .catch((e: Error) => {
            attempt.error = e.name === "Error" ? e.message : e.name
          })
        await Bun.sleep(delayMs)
        if (kind === "abort") {
          client.abort()
        }
        else {
          client.close()
        }
        await pending
        log.event("drop", { ...attempt })
        say(`drop        ${kind.padEnd(5)} ${String(delayMs).padStart(5)} ms after session/new: ` +
            `${attempt.answeredId === undefined ? `no answer (${attempt.error ?? "?"})` : `answered in ${attempt.answeredAfterMs} ms, ${attempt.answeredId}`}`)
      }
    }
    say(`settle      ${options.settleMs / 1000} s, so the spawner can finish the requests that lost their connection`)
    await Bun.sleep(options.settleMs)

    // Path 2: the list of the workspace, where a row names the branch of its session.
    const listedIds = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 5; page++) {
      const result = await observer.listSessions(cursor)
      for (const row of Array.isArray(result.sessions) ? result.sessions.filter(isRecord) : []) {
        const meta = isRecord(row._meta) ? row._meta : {}
        const branch = isRecord(meta.remote) && typeof meta.remote.branch === "string" ? meta.remote.branch : ""
        if (branch.startsWith(`jcp-tank-drop-${runId}-`) && typeof row.sessionId === "string") {
          listedIds.add(row.sessionId)
        }
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined
      if (cursor === undefined) {
        break
      }
    }

    // Path 3: the HTTP list of the sessions. Each session names its branch in its repository state.
    const httpListed = new Map<string, string>()
    const pageSize = 200
    for (let page = 0; page < 40; page++) {
      const outcome = await options.http.sessions(page * pageSize, pageSize)
      if (outcome.status !== 200) {
        say(`http list   GET /sessions: HTTP ${outcome.status} ${outcome.body.slice(0, 200)}`)
        break
      }
      const sessions = JSON.parse(outcome.body) as unknown
      const rows = Array.isArray(sessions) ? sessions.filter(isRecord) : []
      for (const row of rows) {
        const branch = branchOf(row)
        if (branch?.startsWith(`jcp-tank-drop-${runId}-`) && typeof row.sessionId === "string") {
          httpListed.set(row.sessionId, branch)
        }
      }
      if (rows.length < pageSize) {
        say(`http list   ${page * pageSize + rows.length} sessions in GET /sessions`)
        break
      }
    }

    // Path 1: the DRAFT statuses of the observer. The branch in the session tells which attempt created it.
    const candidates = new Set<string>([...draftSeenAt.keys(), ...listedIds, ...httpListed.keys()])
    for (const attempt of attempts) {
      if (attempt.answeredId !== undefined) {
        candidates.add(attempt.answeredId)
      }
    }
    for (const sessionId of candidates) {
      const outcome = await options.http.session(sessionId)
      if (outcome.status !== 200) {
        continue
      }
      const branch = branchOf(JSON.parse(outcome.body) as Record<string, unknown>)
      const attempt = attempts.find((candidate) => candidate.branch === branch)
      if (attempt === undefined) {
        continue
      }
      attempt.draftId = sessionId
      attempt.draftStatus = String((JSON.parse(outcome.body) as Record<string, unknown>).status ?? "?")
      attempt.listed = listedIds.has(sessionId)
      attempt.inHttpList = httpListed.has(sessionId)
    }
    for (const attempt of attempts) {
      log.event("draft", { ...attempt, observed: attempt.draftId !== undefined && draftSeenAt.has(attempt.draftId) })
      const seenAt = attempt.draftId === undefined ? undefined : draftSeenAt.get(attempt.draftId)
      const paths = attempt.draftId === undefined ? "" :
        `; observer ${seenAt === undefined ? "no" : `+${Math.round(seenAt - (attempt.sentAt ?? 0))} ms`}` +
        `, session/list ${attempt.listed === true ? "yes" : "no"}, GET /sessions ${attempt.inHttpList === true ? "yes" : "no"}`
      const verdict = attempt.draftId === undefined
        ? "no draft on the spawner"
        : attempt.answeredId === undefined ? `ORPHANED draft ${attempt.draftId} (${attempt.draftStatus})` : `draft ${attempt.draftId}, known to the client`
      say(`result      ${attempt.kind.padEnd(5)} ${String(attempt.delayMs).padStart(5)} ms: ${verdict}${paths}`)
    }
    const orphans = attempts.filter((attempt) => attempt.answeredId === undefined && attempt.draftId !== undefined)
    // A path counts only if it finds every draft whose ID the client knows.
    const known = attempts.filter((attempt) => attempt.answeredId !== undefined && attempt.draftId !== undefined)
    const validPaths = [
      known.length > 0 && known.every((attempt) => draftSeenAt.has(checkDefined(attempt.draftId))) ? "observer" : undefined,
      known.length > 0 && known.every((attempt) => attempt.listed === true) ? "session/list" : undefined,
      known.length > 0 && known.every((attempt) => attempt.inHttpList === true) ? "GET /sessions" : undefined,
    ].filter((path): path is string => path !== undefined)
    say(`summary     ${orphans.length} orphaned drafts from ${attempts.filter((attempt) => attempt.answeredId === undefined).length} drops before the answer; ` +
        `paths that find every known draft: ${validPaths.join(", ") || "NONE, so an orphan can stay unseen"}`)

    if (orphans.length > 0 && options.recheckMs > 0) {
      say(`recheck     in ${options.recheckMs / 1000} s: does the spawner remove an orphaned draft?`)
      await Bun.sleep(options.recheckMs)
      for (const attempt of orphans) {
        const outcome = await options.http.session(checkDefined(attempt.draftId))
        const status = outcome.status === 200 ? String((JSON.parse(outcome.body) as Record<string, unknown>).status ?? "?") : `HTTP ${outcome.status}`
        log.event("recheck", { draftId: attempt.draftId, status })
        say(`recheck     ${attempt.draftId}: ${status}`)
      }
    }
  }
  finally {
    observer.close()
    await deleteDrafts(options, attempts.flatMap((attempt) => [attempt.draftId, attempt.answeredId]))
  }
}

async function parallelDrafts(options: RaceOptions, runId: string): Promise<void> {
  const { log, say } = options
  const count = options.parallelDrafts
  if (count < 2) {
    return
  }
  const requestIds: (number | undefined)[] = new Array(count)
  const answered: (string | undefined)[] = new Array(count)
  const answeredAt: (number | undefined)[] = new Array(count)
  const before: SessionUpdate[][] = Array.from({ length: count }, () => [])
  // Per connection: the first time a DRAFT status of each session arrived.
  const draftArrivals: Map<string, number>[] = Array.from({ length: count }, () => new Map())
  const clients = await Promise.all(Array.from({ length: count }, (_, index) => AcpClient.connect(options.acpUrl, options.token, {
    // The answer is marked in the frame hook, so an update that follows it in the same packet does not count as earlier.
    onFrame: (direction, text) => {
      log.frame(direction, text)
      if (direction === "out" && text.includes("\"session/new\"")) {
        requestIds[index] = (JSON.parse(text) as { id?: number }).id
      }
      if (direction === "in" && answered[index] === undefined && requestIds[index] !== undefined) {
        const message = JSON.parse(text) as { id?: number, result?: { sessionId?: string } }
        if (message.id === requestIds[index]) {
          answered[index] = message.result?.sessionId ?? "?"
          answeredAt[index] = performance.now()
        }
      }
    },
    onUpdate: (update) => {
      if (answered[index] === undefined) {
        before[index]!.push(update)
      }
      if (update.update.sessionUpdate === "session_info_update" && statusOf(update) === "DRAFT" && !draftArrivals[index]!.has(update.sessionId)) {
        draftArrivals[index]!.set(update.sessionId, performance.now())
      }
    },
  })))
  try {
    await Promise.all(clients.map((client) => client.initialize()))
    const started = performance.now()
    const elapsed = await Promise.all(clients.map((client, index) =>
      client.newSession({ url: options.repositoryUrl, branch: `jcp-tank-parallel-${runId}-${index}` }, options.token)
        .then(() => Math.round(performance.now() - started))
        .catch((e: Error) => `failed: ${e.message}`)))
    await Bun.sleep(options.observeMs)
    const own = new Set(answered.filter((id): id is string => id !== undefined))
    let firstIsForeign = 0
    clients.forEach((_, index) => {
      const ownId = answered[index]
      const updates = before[index]!
      const foreign = updates.filter((update) => update.sessionId !== ownId)
      const first = updates[0]
      if (first !== undefined && first.sessionId !== ownId) {
        firstIsForeign++
      }
      const statuses = foreign.map((update) => `${update.sessionId.slice(0, 8)}:${statusOf(update) ?? String(update.update.sessionUpdate)}`).join(" ")
      // The DRAFT statuses of this run's drafts, timed from this connection's own answer.
      const base = answeredAt[index] ?? started
      const arrivals = [...draftArrivals[index]!.entries()]
        .filter(([sessionId]) => own.has(sessionId))
        .map(([sessionId, at]) => `${sessionId === ownId ? "own" : sessionId.slice(0, 8)} +${Math.round(at - base)} ms`)
      log.event("parallel", { index, own: ownId, elapsed: elapsed[index], before: updates.length, foreign: foreign.length, arrivals })
      say(`parallel    #${index} session/new ${elapsed[index]} ms, ${updates.length} updates before the answer, ` +
          `${foreign.length} of other sessions${statuses === "" ? "" : ` (${statuses})`}; the first one is ` +
          `${first === undefined ? "absent" : first.sessionId === ownId ? "its own" : "OF ANOTHER SESSION"}`)
      say(`            DRAFT statuses of the ${own.size} drafts in ${options.observeMs / 1000} s after the answer: ${arrivals.join(", ") || "none"}`)
    })
    say(`summary     ${firstIsForeign} of ${count} connections saw another session first; Air's probe would delete that session`)
  }
  finally {
    clients.forEach((client) => client.close())
    await deleteDrafts(options, answered)
  }
}

async function deleteDrafts(options: RaceOptions, ids: readonly (string | undefined)[]): Promise<void> {
  const unique = [...new Set(ids.filter((id): id is string => id !== undefined && id !== "?"))]
  if (options.keep) {
    options.say(`keep        ${unique.length} drafts stay: ${unique.join(" ")}`)
    return
  }
  for (const id of unique) {
    const outcome = await options.http.deleteSession(id)
    options.log.event("delete", { sessionId: id, status: outcome.status })
    options.say(`delete      ${id}: HTTP ${outcome.status}`)
  }
}

/** The branch of a spawner session, from its repository state or from its remote. */
function branchOf(session: Readonly<Record<string, unknown>>): string | undefined {
  const repository = isRecord(session.repositoryState) ? session.repositoryState : undefined
  if (typeof repository?.ref === "string") {
    return repository.ref
  }
  const meta = isRecord(session._meta) ? session._meta : undefined
  const remote = isRecord(meta?.remote) ? meta.remote : isRecord(session.remote) ? session.remote : undefined
  return typeof remote?.branch === "string" ? remote.branch : undefined
}

function statusOf(update: SessionUpdate): string | undefined {
  const meta = update.update._meta
  return isRecord(meta) && typeof meta.status === "string" ? meta.status : undefined
}

function checkDefined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("A value is missing")
  }
  return value
}
