import { afterEach, expect, test } from "bun:test"
import { launch, resolveConfigId } from "../src/launch"
import { COLD_TURN, WARM_TURNS } from "../src/turns"
import { CONFIG_OPTIONS, FakeSpawner, REVISION } from "./fake-spawner"
import { until } from "./support"

let spawner: FakeSpawner | undefined

afterEach(() => {
  spawner?.stop()
  spawner = undefined
})

function fake(): FakeSpawner {
  spawner = new FakeSpawner()
  return spawner
}

test("launches, sees the marker, records the statuses, and archives the session", async () => {
  const server = fake()

  const result = await launch(await server.options())

  const turn = result.turns[0]!
  expect(result).toMatchObject({ outcome: "ok", sessionId: "s-1", revision: REVISION })
  expect(result.cleanup).toEqual({ action: "archive", status: 200, ms: expect.any(Number), finalStatus: "ARCHIVED" })
  expect(turn).toMatchObject({ name: "cold", outcome: "ok", stopReason: "end_turn" })
  const p = result.phases
  const order = [p.connected, p.initialized, p.sessionNew, p.configured, turn.promptSent, turn.firstUpdate, turn.markerAt, turn.turnEnd, p.cleaned]
  expect(order.every((value) => value !== undefined)).toBe(true)
  expect([...order].sort((a, b) => a! - b!)).toEqual(order)
  expect(result.statuses.map((entry) => entry.status).slice(0, 5)).toEqual(["LAUNCHING", "CLONING_REPOSITORY", "STARTING_CONTAINER", "LAUNCHING", "RUNNING"])
  expect(server.methods).toEqual([
    "initialize", "session/new",
    "set _agent=codex", "set model=gpt-6-luna", "set reasoning_effort=low", "set mode=read-only",
    "session/prompt",
  ])
  expect(server.http).toEqual(["PUT /sessions/s-1/archive", "GET /sessions/s-1/status"])
})

test("runs a warm turn that proves the commit with a permitted command", async () => {
  const server = fake()

  const result = await launch(await server.options({ turns: [COLD_TURN, WARM_TURNS.git!] }))

  expect(result.outcome).toBe("ok")
  expect(result.turns.map((turn) => [turn.name, turn.outcome, turn.permissions])).toEqual([["cold", "ok", 0], ["warm", "ok", 1]])
  expect(result.turns[1]!.answer).toContain(REVISION)
  expect(server.permissionAnswers).toEqual([{ outcome: { outcome: "selected", optionId: "allow" } }])
})

test("fails the warm check when the permission is denied", async () => {
  const server = fake()

  const result = await launch(await server.options({ turns: [COLD_TURN, WARM_TURNS.git!], permissions: "deny" }))

  expect(result.outcome).toBe("check-failed")
  expect(result.error).toBe(`The answer has no commit ${REVISION.slice(0, 12)}`)
  expect(server.permissionAnswers).toEqual([{ outcome: { outcome: "cancelled" } }])
})

test("ends the turn on lastRequestComplete when the prompt response does not come", async () => {
  const server = fake()
  server.behavior = "lastRequestComplete"

  const result = await launch(await server.options())

  expect(result.outcome).toBe("ok")
  expect(result.turns[0]!.stopReason).toBeUndefined()
})

test("reports a refusal with the text of the spawner", async () => {
  const server = fake()
  server.behavior = "refuse"

  const result = await launch(await server.options())

  expect(result.outcome).toBe("refused")
  expect(result.error).toContain("Read access")
})

test("deletes the draft and sends no prompt when a setting names an unknown value", async () => {
  const server = fake()

  const result = await launch(await server.options({ settings: [{ key: "model", value: "gpt-9" }] }))

  expect(result.outcome).toBe("failed")
  expect(result.error).toContain("has no value \"gpt-9\"")
  expect(server.methods).not.toContain("session/prompt")
  expect(server.http).toEqual(["DELETE /sessions/s-1"])
})

test("times out, cancels the turn, and cleans up", async () => {
  const server = fake()
  server.behavior = "silent"

  const result = await launch(await server.options({ turnTimeoutMs: 100 }))
  await until(() => server.methods.includes("session/cancel"))

  expect(result.outcome).toBe("timeout")
  expect(server.http[0]).toBe("PUT /sessions/s-1/archive")
})

test("aborts on the signal, cancels the turn, and cleans up", async () => {
  const server = fake()
  server.behavior = "silent"
  const abort = new AbortController()
  setTimeout(() => abort.abort(), 100)

  const result = await launch(await server.options({ signal: abort.signal }))
  await until(() => server.methods.includes("session/cancel"))

  expect(result.outcome).toBe("aborted")
  expect(server.http[0]).toBe("PUT /sessions/s-1/archive")
})

test("does not connect when the signal is already aborted", async () => {
  const server = fake()
  const abort = new AbortController()
  abort.abort()

  const result = await launch(await server.options({ signal: abort.signal }))

  expect(result.outcome).toBe("aborted")
  expect(server.methods).toEqual([])
})

test("resolves a setting by config id, then by category", () => {
  expect(resolveConfigId(CONFIG_OPTIONS, { key: "_agent", value: "claude" })).toBe("_agent")
  expect(resolveConfigId(CONFIG_OPTIONS, { key: "thought_level", value: "low" })).toBe("reasoning_effort")
  expect(() => resolveConfigId(CONFIG_OPTIONS, { key: "fast-mode", value: "on" })).toThrow("no config option \"fast-mode\"")
})
