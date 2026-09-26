import type { LaunchResult } from "./launch"

/** One statistic of the report: a duration in milliseconds for each run that reached both ends of the phase. */
export interface Metric {
  readonly name: string
  readonly values: readonly number[]
}

/** The nearest-rank percentile of sorted values. */
export function percentile(sorted: readonly number[], p: number): number | undefined {
  if (sorted.length === 0) {
    return undefined
  }
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)))
  return sorted[rank - 1]
}

/**
 * The phase durations of the runs. The spawner statuses split the cold start: the spawner provisions
 * (`LAUNCHING`), clones, starts the container, the agent starts (`LAUNCHING` again), and the agent answers.
 */
export function metrics(results: readonly LaunchResult[]): Metric[] {
  const table = new Map<string, number[]>()
  const add = (name: string, value: number | undefined) => {
    const values = table.get(name) ?? []
    table.set(name, values)
    if (value !== undefined && Number.isFinite(value) && value >= 0) {
      values.push(value)
    }
  }
  for (const result of results) {
    const cold = result.turns.find((turn) => turn.name === "cold")
    const warm = result.turns.find((turn) => turn.name === "warm")
    const promptAt = cold?.promptSent
    const first = (status: string, after: number | undefined) =>
      after === undefined ? undefined : result.statuses.find((entry) => entry.status === status && entry.at >= after)?.at
    const launching = first("LAUNCHING", promptAt)
    const cloning = first("CLONING_REPOSITORY", promptAt)
    const starting = first("STARTING_CONTAINER", promptAt)
    const agentLaunching = first("LAUNCHING", starting)
    const running = first("RUNNING", promptAt)
    add("connect: TCP + TLS + upgrade", result.connect?.upgradeMs)
    add("initialize", between(result.phases.connected, result.phases.initialized))
    add("session/new", between(result.phases.initialized, result.phases.sessionNew))
    add("config options", between(result.phases.sessionNew, result.phases.configured))
    add("cold: prompt -> LAUNCHING", between(promptAt, launching))
    // Every run reports LAUNCHING and RUNNING. Under concurrency the spawner often skips the statuses between them.
    add("cold: LAUNCHING -> RUNNING", between(launching, running))
    add("cold: LAUNCHING -> CLONING_REPOSITORY", between(launching, cloning))
    add("cold: CLONING -> STARTING_CONTAINER", between(cloning, starting))
    add("cold: STARTING_CONTAINER -> agent LAUNCHING", between(starting, agentLaunching))
    add("cold: agent LAUNCHING -> RUNNING", between(agentLaunching, running))
    add("cold: RUNNING -> marker", between(running, cold?.markerAt))
    add("cold: prompt -> marker", between(promptAt, cold?.markerAt))
    add("warm: prompt -> first update", between(warm?.promptSent, warm?.firstUpdate))
    add("warm: prompt -> marker", between(warm?.promptSent, warm?.markerAt))
    add(`cleanup: ${result.cleanup?.action ?? "none"}`, result.cleanup?.ms)
  }
  return [...table].map(([name, values]) => ({ name, values }))
}

/** The report as text: the outcomes, the error classes, the cleanup, and a percentile table per phase. */
export function report(results: readonly LaunchResult[]): string[] {
  const lines: string[] = []
  const outcomes = countBy(results.map((result) => result.outcome))
  const ok = outcomes.get("ok") ?? 0
  const rate = results.length === 0 ? 0 : (100 * ok) / results.length
  lines.push(`outcome      ${[...outcomes].map(([outcome, n]) => `${outcome} ${n}`).join(", ") || "no runs"}; success ${rate.toFixed(0)}%`)
  const errors = countBy(results.filter((result) => result.outcome !== "ok").map((result) => `${result.outcome}: ${errorClass(result.error)}`))
  for (const [error, n] of errors) {
    lines.push(`  ${n} x ${error}`)
  }
  const final = countBy(results.filter((result) => result.cleanup !== undefined).map((result) => result.cleanup?.finalStatus ?? result.cleanup?.error ?? `HTTP ${result.cleanup?.status}`))
  lines.push(`cleanup      ${[...final].map(([status, n]) => `${status} ${n}`).join(", ") || "none"}`)
  lines.push("")
  lines.push(`${"phase".padEnd(44)} ${"n".padStart(5)}  ${"p50".padStart(8)}  ${"p90".padStart(8)}  ${"p95".padStart(8)}  ${"max".padStart(8)}`)
  for (const metric of metrics(results)) {
    const sorted = [...metric.values].sort((a, b) => a - b)
    const n = `${sorted.length}/${results.length}`.padStart(5)
    // A percentile of a few values says nothing, so the table shows the values themselves.
    const cells = sorted.length < MIN_VALUES_FOR_PERCENTILES
      ? (sorted.length === 0 ? "-".padStart(8) : `values: ${sorted.map(duration).join(", ")}`)
      : [50, 90, 95, 100].map((p) => duration(percentile(sorted, p)).padStart(8)).join("  ")
    lines.push(`${metric.name.padEnd(44)} ${n}  ${cells}`)
  }
  return lines
}

/** Below this count the report lists the values instead of percentiles. */
const MIN_VALUES_FOR_PERCENTILES = 5

function between(from: number | undefined, to: number | undefined): number | undefined {
  return from === undefined || to === undefined ? undefined : to - from
}

function duration(ms: number | undefined): string {
  if (ms === undefined) {
    return "-"
  }
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

/** An error without the parts that differ between runs, so that one cause makes one class. */
function errorClass(error: string | undefined): string {
  return (error ?? "no message")
    .replace(/MARKER-[0-9a-f-]+/g, "MARKER-*")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/\d+/g, "#")
    .slice(0, 100)
}

function countBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return counts
}
