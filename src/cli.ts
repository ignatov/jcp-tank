#!/usr/bin/env bun
import { appendFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { AcpClient, isRecord, type PermissionPolicy, type RemoteTarget } from "./acp"
import { renderBatch, runBatch, type BatchRow } from "./batch"
import { chat, type ChatTarget } from "./chat"
import { readConfig, writeConfig, type Account, type WorkspaceChoice } from "./config"
import { airIncompatibility, describeConfigOptions, describeInitialize, describeTiming, describeUpdate } from "./describe"
import { airWebSessionUrl, PRODUCTION, spawnerAcpUrl, spawnerHttpUrl } from "./env"
import { fetchJbaOAuthConfig } from "./jba-config"
import { jwtClaims, stringClaim } from "./jwt"
import { launch, type Cleanup, type LaunchResult, type Setting, type TurnSpec } from "./launch"
import { browserLogin, openInBrowser } from "./login"
import { report } from "./report"
import { describeClose } from "./rpc"
import { RUNS_DIRECTORY, RunLog } from "./run-log"
import { osSecretStore, SECRET_SERVICE } from "./secrets"
import { SpawnerHttp } from "./spawner"
import { AuthRequiredError, refreshSecretName, spawnerSecretName, TokenMinter, type IssuedToken } from "./tokens"
import { COLD_TURN, WARM_TURNS } from "./turns"
import { ideSelections, resolveWorkspace, workspaceOptions, type WorkspaceOption, type WorkspaceResolution } from "./workspaces"

const USAGE = `Usage: jcp-tank <command> [options]

Commands:
  login [--workspace <id>] [--no-browser]  Sign in to JetBrains Account and mint a spawner token
  workspace [<id>]                         List the workspaces, or select one
  whoami                                   Show the account, the workspace, and the token claims
  token [--force]                          Print the spawner token, for scripts
  logout                                   Delete the stored secrets
  probe                                    Connect to the spawner and send initialize
  draft [--repo <url>] [--branch <name>]   Create a draft session, show its options, and delete it
  launch [options]                         Launch one cloud environment and wait for the marker (billable)
      --agent <id> --model <id>            The agent and the model (default: the spawner defaults)
      --effort <level>                     The reasoning effort (default: low)
      --mode <id>                          The mode (default: read-only, so the agent pushes nothing)
      --set <option>=<value>               Any other config option; repeat for more
      --warm git|readme|marker             Add a second turn on the warm environment (batch default: git)
      --permissions allow|deny             The answer to a permission request (default: allow with --warm git)
      --cleanup archive|delete|none        What to do with the session after the turns (default: archive)
      --timeout <minutes>                  How long to wait for one turn (default: 35)
  batch -n <count> [--stagger <s>]         Launch sessions in parallel, with the launch options (billable)
      --drafts                             Only drafts: new, options, delete; no prompt, no environment (free)
  report [--batch <id>] [--all]            Statistics of the last batch, of one batch, or of every run
  chat [options]                           Start a session and talk to its agent; the first message is billable
      --session <id>                       Attach to an existing session instead, with its history
      --agent, --model, --effort, --mode, --set, --repo, --branch   As for launch
  sessions [--all]                         List the sessions of the workspace
  status <session> | --batch <id>          Show the state of a session, or of every session of a batch
  archive <session>                        End a session and keep its history
`

/** A batch larger than this needs --allow-large: it is load on production, so it needs the approval of the service owners. */
const MAX_BATCH_WITHOUT_FLAG = 20

const env = PRODUCTION
const secrets = osSecretStore()

/** The repository that the cloud runs clone. */
const DEFAULT_REMOTE: RemoteTarget = { url: "https://github.com/ignatov/intellij-erlang.git", branch: "master" }

/** How long `draft` waits for the updates that the spawner pushes as soon as the draft exists. */
const EARLY_UPDATE_WINDOW_MS = 3000

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      workspace: { type: "string" },
      "no-browser": { type: "boolean" },
      force: { type: "boolean" },
      repo: { type: "string" },
      branch: { type: "string" },
      agent: { type: "string" },
      model: { type: "string" },
      effort: { type: "string", default: "low" },
      mode: { type: "string", default: "read-only" },
      set: { type: "string", multiple: true },
      cleanup: { type: "string", default: "archive" },
      timeout: { type: "string", default: "35" },
      session: { type: "string" },
      all: { type: "boolean" },
      count: { type: "string", short: "n" },
      stagger: { type: "string", default: "0" },
      warm: { type: "string" },
      drafts: { type: "boolean" },
      permissions: { type: "string" },
      batch: { type: "string" },
      "allow-large": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  })
  const [command, ...rest] = positionals
  switch (command) {
    case "login":
      return login(values.workspace, values["no-browser"] !== true)
    case "workspace":
      return workspace(rest[0])
    case "whoami":
      return whoami()
    case "token":
      return token(values.force === true)
    case "logout":
      return logout()
    case "probe":
      return probe()
    case "draft":
      return draft({ url: values.repo ?? DEFAULT_REMOTE.url, branch: values.branch ?? DEFAULT_REMOTE.branch })
    case "launch":
    case "batch":
    case "chat": {
      const settings: Setting[] = [
        ...(values.agent === undefined ? [] : [{ key: "_agent", value: values.agent }]),
        ...(values.model === undefined ? [] : [{ key: "model", value: values.model }]),
        { key: "thought_level", value: values.effort },
        { key: "mode", value: values.mode },
        ...(values.set ?? []).map(parseSetting),
      ]
      const remote = { url: values.repo ?? DEFAULT_REMOTE.url, branch: values.branch ?? DEFAULT_REMOTE.branch }
      if (command === "chat") {
        return chatCommand(values.session === undefined ? { kind: "new", remote, settings } : { kind: "attach", sessionId: values.session })
      }
      const warm = values.warm ?? (command === "batch" ? "git" : undefined)
      const warmTurn = warm === undefined ? undefined : WARM_TURNS[warm]
      if (warm !== undefined && warmTurn === undefined) {
        throw new Error(`--warm is ${Object.keys(WARM_TURNS).join(", ")}, not "${warm}"`)
      }
      const plan: RunPlan = {
        remote,
        settings,
        // A draft without a prompt has no environment; the run deletes it.
        turns: values.drafts === true ? [] : warmTurn === undefined ? [COLD_TURN] : [COLD_TURN, warmTurn],
        permissions: parsePermissions(values.permissions ?? (warm === "git" ? "allow" : "deny")),
        cleanup: parseCleanup(values.cleanup),
        turnTimeoutMs: Number(values.timeout) * 60_000,
      }
      if (command === "launch") {
        return launchOnce(plan)
      }
      const count = Number(values.count ?? "3")
      if (!Number.isInteger(count) || count < 1) {
        throw new Error(`-n needs a positive number, not "${values.count}"`)
      }
      if (count > MAX_BATCH_WITHOUT_FLAG && values["allow-large"] !== true) {
        throw new Error(`A batch of more than ${MAX_BATCH_WITHOUT_FLAG} sessions needs --allow-large`)
      }
      return batchCommand(plan, count, Number(values.stagger) * 1000)
    }
    case "report":
      return reportCommand(values.batch, values.all === true)
    case "sessions":
      return sessions(values.all === true)
    case "status":
      return values.batch === undefined ? status(requireArgument(rest[0], "status <session>")) : batchStatus(values.batch)
    case "archive":
      return archive(requireArgument(rest[0], "archive <session>"))
    default:
      console.log(USAGE)
      return command === undefined || values.help === true ? 0 : 2
  }
}

async function minter(): Promise<TokenMinter> {
  return new TokenMinter(env, await fetchJbaOAuthConfig(env.jbaConfigUrl), secrets)
}

async function login(requestedWorkspace: string | undefined, openBrowser: boolean): Promise<number> {
  const oauth = await fetchJbaOAuthConfig(env.jbaConfigUrl)
  const tokens = await browserLogin(oauth, {
    openBrowser: (url) => {
      console.log("Sign in to JetBrains Account in the browser. If no browser opens, go to this URL:")
      console.log(`  ${url}`)
      if (openBrowser) {
        openInBrowser(url)
      }
    },
  })
  const claims = jwtClaims(tokens.idToken)
  const subject = stringClaim(claims, "sub")
  const issuer = stringClaim(claims, "iss")
  if (subject === undefined || issuer === undefined) {
    throw new Error("The ID token has no sub or iss claim")
  }
  const account: Account = {
    subject,
    issuer,
    userId: stringClaim(claims, "user_id"),
    email: stringClaim(claims, "email"),
    login: stringClaim(claims, "jba_login"),
  }
  const tank = new TokenMinter(env, oauth, secrets)
  await tank.saveRefreshData({ refreshToken: tokens.refreshToken, subject, issuer })
  const previous = await readConfig()
  // A workspace choice belongs to one account.
  await writeConfig({ account, workspace: previous.account?.subject === subject ? previous.workspace : undefined })
  console.log(`Signed in as ${describeAccount(account)}.`)
  console.log(`The refresh token is in the Keychain: ${SECRET_SERVICE} / ${refreshSecretName(env)}.`)
  return selectWorkspace(tank, account, requestedWorkspace)
}

async function workspace(requested: string | undefined): Promise<number> {
  const config = await readConfig()
  if (config.account === undefined) {
    console.log("Not signed in. Run `jcp-tank login`.")
    return 1
  }
  const tank = await minter()
  if (requested !== undefined) {
    return selectWorkspace(tank, config.account, requested)
  }
  const options = workspaceOptions((await tank.orgsUserInfo()).token)
  printOptions(options, config.workspace?.workspaceId)
  return 0
}

async function selectWorkspace(tank: TokenMinter, account: Account, requested: string | undefined): Promise<number> {
  const orgsUserInfo = await tank.orgsUserInfo()
  const options = workspaceOptions(orgsUserInfo.token)
  const config = await readConfig()
  const previous = options.find((option) => option.workspaceId === config.workspace?.workspaceId)
  const resolution: WorkspaceResolution = requested === undefined && previous !== undefined
    ? { kind: "chosen", workspace: previous, source: "the previous choice" }
    : resolveWorkspace(options, requested, await ideSelections(), account.userId)
  switch (resolution.kind) {
    case "none":
      console.log("The account has no organization workspace, and a cloud run needs one.")
      console.log(`The orgs-user-info claims are: ${Object.keys(jwtClaims(orgsUserInfo.token)).join(", ")}`)
      return 1
    case "ambiguous":
      console.log("The account has several workspaces. Select one with `jcp-tank workspace <id>`:")
      printOptions(resolution.options, undefined)
      return 1
    case "chosen": {
      const choice: WorkspaceChoice = resolution.workspace
      await writeConfig({ ...config, account, workspace: choice })
      console.log(`Workspace: ${describeWorkspace(choice)}, from ${resolution.source}.`)
      const spawner = await tank.spawnerToken(choice.workspaceId, { force: true })
      console.log(`Spawner token: ${describeToken(spawner)}.`)
      console.log(`It is cached in the Keychain: ${SECRET_SERVICE} / ${spawnerSecretName(env, choice.workspaceId)}.`)
      return 0
    }
  }
}

async function whoami(): Promise<number> {
  const config = await readConfig()
  if (config.account === undefined) {
    console.log("Not signed in. Run `jcp-tank login`.")
    return 1
  }
  console.log(`account    ${describeAccount(config.account)}`)
  if (config.workspace === undefined) {
    console.log("workspace  none. Run `jcp-tank workspace`.")
    return 1
  }
  console.log(`workspace  ${describeWorkspace(config.workspace)}`)
  const spawner = await (await minter()).spawnerToken(config.workspace.workspaceId)
  console.log(`token      ${describeToken(spawner)}`)
  console.log(`claims     ${Object.keys(jwtClaims(spawner.token)).join(", ")}`)
  console.log(`spawner    ${spawnerAcpUrl(env)}, ${spawnerHttpUrl(env)}`)
  return 0
}

async function token(force: boolean): Promise<number> {
  const config = await readConfig()
  if (config.workspace === undefined) {
    console.error("No workspace. Run `jcp-tank login`.")
    return 1
  }
  const spawner = await (await minter()).spawnerToken(config.workspace.workspaceId, { force })
  process.stdout.write(`${spawner.token}\n`)
  return 0
}

async function logout(): Promise<number> {
  const config = await readConfig()
  await secrets.delete(refreshSecretName(env))
  if (config.workspace !== undefined) {
    await secrets.delete(spawnerSecretName(env, config.workspace.workspaceId))
  }
  await writeConfig({})
  console.log("Signed out. The Keychain items and the account data are deleted.")
  return 0
}

async function spawnerToken(): Promise<string> {
  const config = await readConfig()
  if (config.workspace === undefined) {
    throw new AuthRequiredError("No workspace is selected. Run `jcp-tank login`.")
  }
  return (await (await minter()).spawnerToken(config.workspace.workspaceId)).token
}

async function probe(): Promise<number> {
  const token = await spawnerToken()
  const log = await RunLog.create("probe")
  try {
    const client = await AcpClient.connect(spawnerAcpUrl(env), token, {
      onFrame: (direction, text) => log.frame(direction, text),
      onClose: (event) => log.event("close", { close: describeClose(event) }),
    })
    console.log(`connect     ${describeTiming(client.timing)}`)
    const started = log.elapsed()
    const result = await client.initialize()
    console.log(`initialize  ${log.elapsed() - started} ms`)
    describeInitialize(result).forEach((line) => console.log(line))
    const problem = airIncompatibility(result)
    console.log(problem === undefined ? "verdict     Air can use this agent" : `verdict     Air would refuse it: ${problem}`)
    client.close()
    return problem === undefined ? 0 : 1
  }
  finally {
    await log.close()
    console.log(`log         ${log.path}`)
  }
}

async function draft(remote: RemoteTarget): Promise<number> {
  const token = await spawnerToken()
  const spawner = new SpawnerHttp(spawnerHttpUrl(env), async () => token)
  const log = await RunLog.create("draft")
  let client: AcpClient | undefined
  let sessionId: string | undefined
  // The id of an update that came before the session/new response: a failed session/new can leave a draft.
  let sniffedSessionId: string | undefined
  try {
    client = await AcpClient.connect(spawnerAcpUrl(env), token, {
      onFrame: (direction, text) => log.frame(direction, text),
      onUpdate: (update) => {
        // Every connection gets the status updates of every session of the workspace, so a status update
        // cannot name this draft.
        if (update.update.sessionUpdate === "session_info_update" && update.sessionId !== sessionId) {
          return
        }
        sniffedSessionId ??= update.sessionId
        console.log(`update      +${log.elapsed()} ms ${describeUpdate(update)}`)
      },
      onNotification: (method) => console.log(`notify      +${log.elapsed()} ms ${method}`),
      onClose: (event) => log.event("close", { close: describeClose(event) }),
    })
    console.log(`connect     ${describeTiming(client.timing)}`)
    let started = log.elapsed()
    await client.initialize()
    console.log(`initialize  ${log.elapsed() - started} ms`)
    started = log.elapsed()
    const created = await client.newSession(remote, token)
    sessionId = typeof created.sessionId === "string" ? created.sessionId : undefined
    console.log(`session/new ${log.elapsed() - started} ms, session ${sessionId ?? "?"}, ${remote.url} @ ${remote.branch}`)
    describeConfigOptions(created.configOptions).forEach((line) => console.log(line))
    await Bun.sleep(EARLY_UPDATE_WINDOW_MS)
    return sessionId === undefined ? 1 : 0
  }
  finally {
    const target = sessionId ?? sniffedSessionId
    if (target !== undefined) {
      try {
        const outcome = await spawner.deleteSession(target)
        log.event("delete", { sessionId: target, status: outcome.status, ms: outcome.ms, body: outcome.body })
        console.log(`DELETE      HTTP ${outcome.status} in ${outcome.ms} ms${outcome.body === "" ? "" : `: ${outcome.body.slice(0, 200)}`}`)
      }
      catch (e) {
        console.log(`DELETE      failed: ${(e as Error).message}. The draft ${target} stays until the spawner removes it.`)
      }
    }
    client?.close()
    await log.close()
    console.log(`log         ${log.path}`)
  }
}

/** What every session of a launch or a batch does. */
interface RunPlan {
  readonly remote: RemoteTarget
  readonly settings: readonly Setting[]
  readonly turns: readonly TurnSpec[]
  readonly permissions: PermissionPolicy
  readonly cleanup: Cleanup
  readonly turnTimeoutMs: number
}

const LAUNCHES_FILE = join(RUNS_DIRECTORY, "launches.jsonl")
const BATCHES_FILE = join(RUNS_DIRECTORY, "batches.jsonl")

/** Aborts on the first Ctrl-C, so the runs cancel their turns and clean up. The second Ctrl-C quits at once. */
function interruptible<T>(body: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController()
  const onInterrupt = () => {
    if (abort.signal.aborted) {
      process.exit(130)
    }
    console.log("\nAborting: the turns are cancelled and the sessions are cleaned up. Press Ctrl-C again to quit now.")
    abort.abort()
  }
  process.on("SIGINT", onInterrupt)
  return body(abort.signal).finally(() => process.off("SIGINT", onInterrupt))
}

async function launchOnce(plan: RunPlan): Promise<number> {
  const token = await spawnerToken()
  const log = await RunLog.create("launch")
  try {
    console.log(`launch       ${plan.remote.url} @ ${plan.remote.branch}; turns ${plan.turns.map((turn) => turn.name).join(", ")}; cleanup ${plan.cleanup}`)
    const result = await interruptible((signal) => launch({
      ...plan,
      acpUrl: spawnerAcpUrl(env),
      spawner: new SpawnerHttp(spawnerHttpUrl(env), async () => token),
      token,
      log,
      progress: (line) => console.log(line),
      signal,
    }))
    await appendFile(LAUNCHES_FILE, `${JSON.stringify(result)}\n`)
    const times = result.turns
      .filter((turn) => turn.markerAt !== undefined && turn.promptSent !== undefined)
      .map((turn) => `${turn.name} ${((turn.markerAt! - turn.promptSent!) / 1000).toFixed(1)} s`)
    console.log(`result       ${result.outcome}${times.length === 0 ? "" : `: ${times.join(", ")} from the prompt to the marker`}${result.error === undefined ? "" : `; ${result.error}`}`)
    return result.outcome === "ok" ? 0 : 1
  }
  finally {
    await log.close()
    console.log(`log          ${log.path}`)
  }
}

async function batchCommand(plan: RunPlan, count: number, staggerMs: number): Promise<number> {
  const token = await spawnerToken()
  const tty = process.stdout.isTTY === true
  const started = performance.now()
  let rows: readonly BatchRow[] = []
  let drawn = 0
  const draw = () => {
    const lines = renderBatch(rows, performance.now() - started)
    process.stdout.write(`${drawn > 0 ? `\x1b[${drawn}F` : ""}${lines.map((line) => `\x1b[2K${line}\n`).join("")}`)
    drawn = lines.length
  }
  const seen = new Map<number, string>()
  const onChange = (current: readonly BatchRow[]) => {
    rows = current
    if (tty) {
      return
    }
    // Without a terminal, print each change of a row as a line.
    for (const row of current) {
      const key = `${row.state}|${row.outcome ?? ""}`
      if (row.startedAt !== undefined && seen.get(row.index) !== key) {
        seen.set(row.index, key)
        const at = ((performance.now() - started) / 1000).toFixed(1).padStart(6)
        console.log(`${at} s  #${String(row.index + 1).padStart(2)} ${(row.sessionId ?? "-").slice(0, 8).padEnd(8)} ${row.state}${row.outcome === undefined ? "" : ` -> ${row.outcome}`}`)
      }
    }
  }
  console.log(`batch        ${count} sessions, stagger ${staggerMs / 1000} s, turns ${plan.turns.map((turn) => turn.name).join(", ")}, ${plan.remote.url} @ ${plan.remote.branch}`)
  const timer = tty ? setInterval(draw, 500) : undefined
  try {
    const batch = await interruptible((signal) => runBatch({
      count,
      staggerMs,
      directory: RUNS_DIRECTORY,
      signal,
      onChange,
      launch: { ...plan, acpUrl: spawnerAcpUrl(env), spawner: new SpawnerHttp(spawnerHttpUrl(env), async () => token), token },
    }))
    clearInterval(timer)
    if (tty) {
      draw()
    }
    await appendFile(LAUNCHES_FILE, batch.results.map((result) => `${JSON.stringify(result)}\n`).join(""))
    const outcomes: Record<string, number> = {}
    batch.results.forEach((result) => outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1)
    await appendFile(BATCHES_FILE, `${JSON.stringify({
      batchId: batch.batchId, startedAt: batch.startedAt, durationMs: batch.durationMs, count, staggerMs,
      remote: plan.remote, settings: plan.settings, turns: plan.turns.map((turn) => turn.name), outcomes,
    })}\n`)
    console.log("")
    report(batch.results).forEach((line) => console.log(line))
    console.log("")
    console.log(`batch id     ${batch.batchId}`)
    console.log(`logs         ${join(RUNS_DIRECTORY, `batch-${batch.batchId}`)}`)
    console.log(`again        ./jcp-tank report --batch ${batch.batchId}; ./jcp-tank status --batch ${batch.batchId}`)
    return batch.results.every((result) => result.outcome === "ok") ? 0 : 1
  }
  finally {
    clearInterval(timer)
  }
}

async function readLaunches(): Promise<LaunchResult[]> {
  let text: string
  try {
    text = await readFile(LAUNCHES_FILE, "utf8")
  }
  catch {
    return []
  }
  const records = text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Partial<LaunchResult>)
  const valid = records.filter((record): record is LaunchResult => Array.isArray(record.turns) && Array.isArray(record.statuses))
  if (valid.length < records.length) {
    console.log(`warning      ${records.length - valid.length} lines of ${LAUNCHES_FILE} have no turns or statuses; the report skips them`)
  }
  return valid
}

async function reportCommand(requested: string | undefined, all: boolean): Promise<number> {
  const launches = await readLaunches()
  const lastBatch = [...launches].reverse().find((result) => typeof result.tags?.batchId === "string")?.tags?.batchId as string | undefined
  const batchId = all ? undefined : requested ?? lastBatch
  const selected = batchId === undefined ? launches : launches.filter((result) => result.tags?.batchId === batchId)
  console.log(`report       ${selected.length} runs${batchId === undefined ? ", every run" : ` of batch ${batchId}`}`)
  report(selected).forEach((line) => console.log(line))
  return 0
}

async function batchStatus(batchId: string): Promise<number> {
  const sessionsOfBatch = (await readLaunches()).filter((result) => result.tags?.batchId === batchId && result.sessionId !== undefined)
  if (sessionsOfBatch.length === 0) {
    console.log(`No sessions of batch ${batchId} are in ${LAUNCHES_FILE}.`)
    return 1
  }
  const token = await spawnerToken()
  const http = new SpawnerHttp(spawnerHttpUrl(env), async () => token)
  const statuses = await Promise.all(sessionsOfBatch.map(async (result) => {
    const outcome = await http.sessionStatus(result.sessionId!)
    return { result, status: outcome.status === 200 ? outcome.body.replaceAll("\"", "") : `HTTP ${outcome.status}` }
  }))
  for (const { result, status: current } of statuses) {
    console.log(`#${String(Number(result.tags?.index ?? 0) + 1).padStart(2)} ${result.sessionId}  ${current.padEnd(20)} run outcome ${result.outcome}`)
  }
  return 0
}

async function chatCommand(target: ChatTarget): Promise<number> {
  const config = await readConfig()
  const token = await spawnerToken()
  const organizationId = config.workspace?.organizationId ?? ""
  const log = await RunLog.create("chat")
  try {
    await chat({
      acpUrl: spawnerAcpUrl(env),
      spawner: new SpawnerHttp(spawnerHttpUrl(env), async () => token),
      token,
      target,
      webUrl: (sessionId) => airWebSessionUrl(env, organizationId, sessionId),
      log,
      input: process.stdin,
      write: (text) => void process.stdout.write(text),
      terminal: process.stdin.isTTY === true,
    })
    return 0
  }
  finally {
    await log.close()
  }
}

async function sessions(all: boolean): Promise<number> {
  const token = await spawnerToken()
  const log = await RunLog.create("sessions")
  const client = await AcpClient.connect(spawnerAcpUrl(env), token, { onFrame: (direction, text) => log.frame(direction, text) })
  try {
    await client.initialize()
    const rows: Record<string, unknown>[] = []
    let cursor: string | undefined
    for (let page = 0; page < 50; page++) {
      const result = await client.listSessions(cursor)
      rows.push(...(Array.isArray(result.sessions) ? result.sessions.filter(isRecord) : []))
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined
      if (cursor === undefined || (!all && rows.length >= 20)) {
        break
      }
    }
    for (const row of all ? rows : rows.slice(0, 20)) {
      const meta = isRecord(row._meta) ? row._meta : {}
      const remote = isRecord(meta.remote) && typeof meta.remote.url === "string" ? meta.remote.url.replace(/^https:\/\/github\.com\//, "") : ""
      const title = String(row.title ?? "").replace(/\s+/g, " ").slice(0, 50)
      console.log(`${String(row.updatedAt ?? "").slice(0, 19)}  ${String(meta.status ?? "?").padEnd(18)} ${String(row.sessionId)}  ${remote.padEnd(28)} ${title}`)
    }
    if (!all && cursor !== undefined) {
      console.log("... more sessions exist. Use --all to list them.")
    }
    return 0
  }
  finally {
    client.close()
    await log.close()
  }
}

async function status(sessionId: string): Promise<number> {
  const token = await spawnerToken()
  const outcome = await new SpawnerHttp(spawnerHttpUrl(env), async () => token).session(sessionId)
  if (outcome.status !== 200) {
    console.log(`HTTP ${outcome.status}: ${outcome.body.slice(0, 300)}`)
    return 1
  }
  const session = JSON.parse(outcome.body) as Record<string, unknown>
  const repository = isRecord(session.repositoryState) ? session.repositoryState : {}
  const config = await readConfig()
  console.log(`status      ${String(session.status)}${session.statusComment === undefined ? "" : `: ${String(session.statusComment)}`}`)
  console.log(`name        ${String(session.sessionName ?? "")}`)
  console.log(`agent       ${String(session.agentType ?? "?")}, launched from ${String(session.launchedFrom ?? "?")}`)
  console.log(`repository  ${String(repository.organization ?? "?")}/${String(repository.repositoryName ?? "?")} @ ${String(repository.ref ?? "?")} ${String(repository.commitHash ?? "").slice(0, 12)}`)
  console.log(`updated     ${String(session.updatedAt ?? "")}`)
  console.log(`web         ${airWebSessionUrl(env, config.workspace?.organizationId ?? "", sessionId)}`)
  return 0
}

async function archive(sessionId: string): Promise<number> {
  const token = await spawnerToken()
  const outcome = await new SpawnerHttp(spawnerHttpUrl(env), async () => token).archiveSession(sessionId)
  console.log(`archive     HTTP ${outcome.status} in ${outcome.ms} ms${outcome.body === "" ? "" : `: ${outcome.body.slice(0, 200)}`}`)
  return outcome.status >= 200 && outcome.status < 300 ? 0 : 1
}

function requireArgument(value: string | undefined, usage: string): string {
  if (value === undefined) {
    throw new Error(`Usage: jcp-tank ${usage}`)
  }
  return value
}

function parseSetting(text: string): Setting {
  const equals = text.indexOf("=")
  if (equals <= 0) {
    throw new Error(`--set needs <option>=<value>, not "${text}"`)
  }
  return { key: text.slice(0, equals), value: text.slice(equals + 1) }
}

function parsePermissions(text: string): PermissionPolicy {
  if (text === "allow" || text === "deny") {
    return text
  }
  throw new Error(`--permissions is allow or deny, not "${text}"`)
}

function parseCleanup(text: string): Cleanup {
  if (text === "archive" || text === "delete" || text === "none") {
    return text
  }
  throw new Error(`--cleanup is archive, delete, or none, not "${text}"`)
}

function describeAccount(account: Account): string {
  const name = account.email ?? account.login ?? account.subject
  return `${name} (user ${account.userId ?? "?"}, subject ${account.subject})`
}

function describeWorkspace(workspace: WorkspaceChoice): string {
  const organization = workspace.organizationName === undefined ? "" : ` "${workspace.organizationName}"`
  const name = workspace.workspaceName === undefined ? "" : ` "${workspace.workspaceName}"`
  return `${workspace.workspaceId}${name} in organization ${workspace.organizationId}${organization}`
}

function describeToken(issued: IssuedToken): string {
  const claims = jwtClaims(issued.token)
  const audience = Array.isArray(claims.aud) ? claims.aud.join(",") : String(claims.aud)
  const minutes = Math.round((issued.expiresAt - Date.now()) / 60_000)
  return `audience ${audience}, valid for ${minutes} min, until ${new Date(issued.expiresAt).toISOString()}`
}

function printOptions(options: readonly WorkspaceOption[], selected: string | undefined): void {
  if (options.length === 0) {
    console.log("  (no workspaces)")
  }
  for (const option of options) {
    const mark = option.workspaceId === selected ? "*" : " "
    console.log(` ${mark} ${describeWorkspace(option)}`)
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(error instanceof AuthRequiredError ? message : `jcp-tank: ${message}`)
    process.exit(1)
  },
)
