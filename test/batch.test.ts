import { afterEach, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { renderBatch, runBatch, type BatchRow } from "../src/batch"
import { COLD_TURN, WARM_TURNS } from "../src/turns"
import { FakeSpawner } from "./fake-spawner"

let spawner: FakeSpawner | undefined

afterEach(() => {
  spawner?.stop()
  spawner = undefined
})

test("runs the sessions in parallel, one connection each, and tags each result with the batch", async () => {
  spawner = new FakeSpawner()
  const { log: _, ...launch } = await spawner.options({ turns: [COLD_TURN, WARM_TURNS.git!] })
  const directory = await spawner.directory()
  let rows: readonly BatchRow[] = []

  const batch = await runBatch({ count: 3, staggerMs: 0, directory, launch, signal: new AbortController().signal, onChange: (current) => rows = current })

  expect(batch.results.map((result) => result.outcome)).toEqual(["ok", "ok", "ok"])
  expect(new Set(batch.results.map((result) => result.sessionId))).toEqual(new Set(["s-1", "s-2", "s-3"]))
  expect(batch.results.map((result) => result.tags)).toEqual([0, 1, 2].map((index) => ({ batchId: batch.batchId, index, concurrency: 3, staggerMs: 0 })))
  expect(rows.map((row) => [row.outcome, row.state, row.coldMs !== undefined, row.warmMs !== undefined])).toEqual(Array(3).fill(["ok", "ARCHIVED", true, true]))
  expect(spawner.http.filter((call) => call.startsWith("PUT")).length).toBe(3)
  expect((await readdir(join(directory, `batch-${batch.batchId}`))).length).toBe(3)
})

test("records only the statuses of its own session when the spawner sends the statuses of all sessions", async () => {
  spawner = new FakeSpawner()
  spawner.broadcastStatuses = true
  const { log: _, ...launch } = await spawner.options()

  const batch = await runBatch({ count: 3, staggerMs: 0, directory: await spawner.directory(), launch, signal: new AbortController().signal })

  for (const result of batch.results) {
    expect(result.statuses.map((entry) => entry.status).slice(0, 5)).toEqual(["LAUNCHING", "CLONING_REPOSITORY", "STARTING_CONTAINER", "LAUNCHING", "RUNNING"])
    expect(result.statuses.length).toBeLessThanOrEqual(6)
  }
})

test("an abort cancels the running session and skips the sessions that wait", async () => {
  spawner = new FakeSpawner()
  spawner.behavior = "silent"
  const { log: _, ...launch } = await spawner.options()
  const abort = new AbortController()
  setTimeout(() => abort.abort(), 150)

  const batch = await runBatch({ count: 3, staggerMs: 1000, directory: await spawner.directory(), launch, signal: abort.signal })

  expect(batch.results.map((result) => result.outcome)).toEqual(["aborted", "aborted", "aborted"])
  expect(batch.results.map((result) => result.sessionId)).toEqual(["s-1", undefined, undefined])
  expect(spawner.methods).toContain("session/cancel")
  expect(spawner.http[0]).toBe("PUT /sessions/s-1/archive")
})

test("renders one line per session and a total", () => {
  const rows: BatchRow[] = [
    { index: 0, sessionId: "f8918342-7ace", state: "ARCHIVED", coldMs: 47_200, warmMs: 6_100, outcome: "ok" },
    { index: 1, sessionId: "3b1c77e0-0000", state: "CLONING_REPOSITORY" },
  ]

  const lines = renderBatch(rows, 65_000)

  expect(lines[1]).toBe("  1  f8918342  ARCHIVED                47.2 s     6.1 s  ok")
  expect(lines[2]).toBe("  2  3b1c77e0  CLONING_REPOSITORY           -         -  ")
  expect(lines[3]).toBe("elapsed 65.0 s; done 1/2; ok 1")
})
