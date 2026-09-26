import { expect, test } from "bun:test"
import type { LaunchResult } from "../src/launch"
import { metrics, percentile, report } from "../src/report"

function run(overrides: Partial<LaunchResult> = {}): LaunchResult {
  return {
    runId: "r",
    startedAt: "2026-09-26T17:00:00Z",
    remote: { url: "https://github.com/ignatov/intellij-erlang.git", branch: "master" },
    settings: [],
    outcome: "ok",
    phases: { connected: 200, initialized: 240, sessionNew: 500, configured: 900, cleaned: 60_000 },
    statuses: [
      { status: "DRAFT", at: 1_900 },
      { status: "LAUNCHING", at: 2_000 },
      { status: "CLONING_REPOSITORY", at: 17_000 },
      { status: "STARTING_CONTAINER", at: 21_000 },
      { status: "LAUNCHING", at: 24_000 },
      { status: "RUNNING", at: 39_000 },
    ],
    turns: [
      { name: "cold", marker: "MARKER-r-1", promptSent: 1_000, firstUpdate: 1_900, markerAt: 47_000, turnEnd: 47_100, outcome: "ok", permissions: 0 },
      { name: "warm", marker: "MARKER-r-2", promptSent: 48_000, firstUpdate: 48_500, markerAt: 54_000, turnEnd: 54_100, outcome: "ok", permissions: 1 },
    ],
    connect: { tcpMs: 40, tlsMs: 70, upgradeMs: 160 },
    updates: 20,
    cleanup: { action: "archive", status: 200, ms: 190, finalStatus: "ARCHIVED" },
    ...overrides,
  }
}

test("takes the nearest-rank percentile", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

  expect([50, 90, 95, 100].map((p) => percentile(values, p))).toEqual([5, 9, 10, 10])
  expect(percentile([], 50)).toBeUndefined()
})

test("splits the cold start at the spawner statuses", () => {
  const byName = Object.fromEntries(metrics([run()]).map((metric) => [metric.name, metric.values]))

  expect(byName).toMatchObject({
    "connect: TCP + TLS + upgrade": [160],
    "session/new": [260],
    "cold: prompt -> LAUNCHING": [1_000],
    "cold: LAUNCHING -> RUNNING": [37_000],
    "cold: LAUNCHING -> CLONING_REPOSITORY": [15_000],
    "cold: CLONING -> STARTING_CONTAINER": [4_000],
    "cold: STARTING_CONTAINER -> agent LAUNCHING": [3_000],
    "cold: agent LAUNCHING -> RUNNING": [15_000],
    "cold: RUNNING -> marker": [8_000],
    "cold: prompt -> marker": [46_000],
    "warm: prompt -> marker": [6_000],
    "cleanup: archive": [190],
  })
})

test("counts the outcomes, groups the errors, and skips a phase that a failed run never reached", () => {
  const timeout = (runId: string) => run({
    runId,
    outcome: "timeout",
    error: "The turn did not end within 2100 s",
    statuses: [],
    turns: [{ name: "cold", marker: `MARKER-${runId}-1`, promptSent: 1_000, outcome: "timeout", permissions: 0 }],
  })

  const lines = report([run(), timeout("a"), timeout("b")])

  expect(lines[0]).toBe("outcome      ok 1, timeout 2; success 33%")
  expect(lines[1]).toBe("  2 x timeout: The turn did not end within # s")
  expect(lines[2]).toBe("cleanup      ARCHIVED 3")
  expect(lines.find((line) => line.startsWith("cold: prompt -> marker"))).toMatch(/cold: prompt -> marker\s+1\/3\s+values: 46\.0 s$/)
})

test("shows percentiles from five values on", () => {
  const runs = [40, 45, 50, 55, 60].map((seconds) => run({
    turns: [{ name: "cold", marker: "M", promptSent: 0, markerAt: seconds * 1000, outcome: "ok", permissions: 0 }],
  }))

  const line = report(runs).find((entry) => entry.startsWith("cold: prompt -> marker"))

  expect(line).toMatch(/5\/5\s+50\.0 s\s+60\.0 s\s+60\.0 s\s+60\.0 s$/)
})
