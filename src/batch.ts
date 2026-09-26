import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { launch, type LaunchOptions, type LaunchResult } from "./launch"
import { RunLog } from "./run-log"

/** The live state of one session of a batch. The times are milliseconds since the start of the batch. */
export interface BatchRow {
  readonly index: number
  sessionId?: string
  state: string
  startedAt?: number
  coldMs?: number
  warmMs?: number
  outcome?: string
}

export interface BatchOptions {
  readonly count: number
  /** The pause between two starts. 0 starts every session at once. */
  readonly staggerMs: number
  /** The runs directory. Each batch gets a directory in it, with one frame log per session. */
  readonly directory: string
  readonly launch: Omit<LaunchOptions, "log" | "observer" | "tags" | "progress" | "signal">
  readonly signal: AbortSignal
  readonly onChange?: (rows: readonly BatchRow[]) => void
}

export interface BatchResult {
  readonly batchId: string
  readonly startedAt: string
  readonly durationMs: number
  readonly results: readonly LaunchResult[]
}

/**
 * Runs sessions in parallel, one WebSocket each, because the spawner serves one session per connection.
 * Every session follows the same turns, then cleans up. The results carry the batch id, so the report can
 * select them.
 */
export async function runBatch(options: BatchOptions): Promise<BatchResult> {
  const startedAt = new Date().toISOString()
  const batchId = `${startedAt.slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}-${randomBytes(2).toString("hex")}`
  const directory = join(options.directory, `batch-${batchId}`)
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  const rows: BatchRow[] = Array.from({ length: options.count }, (_, index) => ({ index, state: "waiting" }))
  const changed = () => options.onChange?.(rows)

  const results = await Promise.all(rows.map(async (row) => {
    await pause(row.index * options.staggerMs, options.signal)
    row.startedAt = elapsed()
    changed()
    const log = await RunLog.create(String(row.index + 1).padStart(2, "0"), directory)
    try {
      const result = await launch({
        ...options.launch,
        log,
        signal: options.signal,
        tags: { batchId, index: row.index, concurrency: options.count, staggerMs: options.staggerMs },
        observer: {
          onSession: (sessionId) => {
            row.sessionId = sessionId
            changed()
          },
          onState: (state) => {
            row.state = state
            changed()
          },
          onTurnEnd: (turn) => {
            const ms = turn.markerAt !== undefined && turn.promptSent !== undefined ? turn.markerAt - turn.promptSent : undefined
            if (turn.name === "cold") {
              row.coldMs = ms
            }
            else {
              row.warmMs = ms
            }
            changed()
          },
        },
      })
      row.outcome = result.outcome
      changed()
      return result
    }
    finally {
      await log.close()
    }
  }))
  return { batchId, startedAt, durationMs: elapsed(), results }
}

/** The rows as a table, one line per session, plus a total line. */
export function renderBatch(rows: readonly BatchRow[], elapsedMs: number): string[] {
  const seconds = (ms: number | undefined) => ms === undefined ? "-" : `${(ms / 1000).toFixed(1)} s`
  const lines = [`${"#".padStart(3)}  ${"session".padEnd(8)}  ${"state".padEnd(20)}  ${"cold".padStart(8)}  ${"warm".padStart(8)}  result`]
  for (const row of rows) {
    lines.push([
      String(row.index + 1).padStart(3),
      (row.sessionId ?? "-").slice(0, 8).padEnd(8),
      row.state.slice(0, 20).padEnd(20),
      seconds(row.coldMs).padStart(8),
      seconds(row.warmMs).padStart(8),
      row.outcome ?? "",
    ].join("  "))
  }
  const done = rows.filter((row) => row.outcome !== undefined)
  const ok = done.filter((row) => row.outcome === "ok").length
  lines.push(`elapsed ${seconds(elapsedMs)}; done ${done.length}/${rows.length}; ok ${ok}`)
  return lines
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
}
