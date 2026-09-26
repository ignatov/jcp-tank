import { afterEach, expect, test } from "bun:test"
import type { Server } from "bun"
import type { JcpEnvironment } from "../src/env"
import type { JbaOAuthConfig } from "../src/jba-config"
import { MemorySecretStore } from "../src/secrets"
import { AuthRequiredError, expiresSoon, refreshSecretName, TokenMinter } from "../src/tokens"
import { fakeJwt } from "./support"

const ENV: JcpEnvironment = { name: "test", jcpUrl: "http://127.0.0.1", jbaConfigUrl: "unused", airWebUrl: "unused" }
const WORKSPACE = "ws-1"
const ORGS_USER_INFO = fakeJwt({
  exp: Math.floor(Date.now() / 1000) + 300,
  orgMemberships: [{ orgId: "org-1", workspaces: [{ id: WORKSPACE }] }],
})

/** A token endpoint and an orgs-user-info endpoint that record every request. */
class FakeAccountService {
  readonly forms: URLSearchParams[] = []
  readonly orgsUserInfoAuthorizations: (string | null)[] = []
  rotateTo: string | undefined
  tokenStatus = 200
  orgsUserInfoBody = JSON.stringify({ jwt: ORGS_USER_INFO, expires_in: 300 })
  spawnerMints = 0
  readonly server: Server<undefined>

  constructor() {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        if (url.pathname === "/oauth2/token") {
          const form = new URLSearchParams(await request.text())
          this.forms.push(form)
          if (this.tokenStatus !== 200) {
            return Response.json({ error: "invalid_grant" }, { status: this.tokenStatus })
          }
          const audience = form.get("audience")
          if (audience === "jcp-agent-spawner") {
            this.spawnerMints++
          }
          return Response.json({
            access_token: fakeJwt({ aud: audience, n: this.forms.length }),
            expires_in: 3600,
            ...(this.rotateTo === undefined ? {} : { refresh_token: this.rotateTo }),
          })
        }
        if (url.pathname === "/orgsuserinfo") {
          this.orgsUserInfoAuthorizations.push(request.headers.get("authorization"))
          return new Response(this.orgsUserInfoBody)
        }
        return new Response("not found", { status: 404 })
      },
    })
  }

  get oauth(): JbaOAuthConfig {
    const base = `http://127.0.0.1:${this.server.port}`
    return {
      clientId: "ide",
      scope: "openid offline_access r_ide_auth",
      authEndpoint: `${base}/oauth/login`,
      tokenEndpoint: `${base}/oauth2/token`,
      orgsUserInfoJwtEndpoint: `${base}/orgsuserinfo`,
    }
  }
}

let service: FakeAccountService | undefined

afterEach(() => {
  void service?.server.stop(true)
  service = undefined
})

async function signedInMinter(now: () => number = Date.now): Promise<{ minter: TokenMinter, secrets: MemorySecretStore, service: FakeAccountService }> {
  service = new FakeAccountService()
  const secrets = new MemorySecretStore()
  const minter = new TokenMinter(ENV, service.oauth, secrets, now)
  await minter.saveRefreshData({ refreshToken: "refresh-1", subject: "sub-1", issuer: "https://issuer" })
  return { minter, secrets, service }
}

test("mints a spawner token through org-service and orgs-user-info, with the form of JBAManager", async () => {
  const { minter, service } = await signedInMinter()

  await minter.spawnerToken(WORKSPACE)

  expect(service.forms.map((form) => Object.fromEntries(form))).toEqual([
    { grant_type: "switch_audience", client_id: "ide", refresh_token: "refresh-1", audience: "org-service" },
    {
      grant_type: "switch_audience",
      client_id: "ide",
      refresh_token: "refresh-1",
      audience: "jcp-agent-spawner",
      workspace_id: WORKSPACE,
      orgs_user_info: ORGS_USER_INFO,
    },
  ])
  expect(service.orgsUserInfoAuthorizations).toEqual([`Bearer ${fakeJwt({ aud: "org-service", n: 1 })}`])
})

test("saves a rotated refresh token and keeps the identity", async () => {
  const { minter, secrets, service } = await signedInMinter()
  service.rotateTo = "refresh-2"

  await minter.switchAudience("org-service")

  expect(JSON.parse((await secrets.get(refreshSecretName(ENV)))!)).toEqual({
    refreshToken: "refresh-2",
    subject: "sub-1",
    issuer: "https://issuer",
  })
})

test("reuses the cached spawner token until it expires soon", async () => {
  let now = 1_000_000
  const { minter, service } = await signedInMinter(() => now)

  const first = await minter.spawnerToken(WORKSPACE)
  now += 49 * 60_000
  const second = await minter.spawnerToken(WORKSPACE)
  now += 2 * 60_000
  const third = await minter.spawnerToken(WORKSPACE)

  expect(second).toEqual(first)
  expect(third.token).not.toBe(first.token)
  expect(service.spawnerMints).toBe(2)
})

test("shares one mint between concurrent callers", async () => {
  const { minter, service } = await signedInMinter()

  const tokens = await Promise.all([minter.spawnerToken(WORKSPACE), minter.spawnerToken(WORKSPACE), minter.spawnerToken(WORKSPACE)])

  expect(new Set(tokens.map((t) => t.token)).size).toBe(1)
  expect(service.spawnerMints).toBe(1)
})

test("asks for a login when the token endpoint rejects the refresh token", async () => {
  const { minter, service } = await signedInMinter()
  service.tokenStatus = 400

  expect(minter.spawnerToken(WORKSPACE)).rejects.toBeInstanceOf(AuthRequiredError)
})

test("asks for a login when no refresh token is stored", async () => {
  service = new FakeAccountService()
  const minter = new TokenMinter(ENV, service.oauth, new MemorySecretStore())

  expect(minter.spawnerToken(WORKSPACE)).rejects.toThrow("jcp-tank login")
})

test("accepts a bare JWT from the orgs-user-info endpoint", async () => {
  const { minter, service } = await signedInMinter()
  service.orgsUserInfoBody = ORGS_USER_INFO

  expect((await minter.orgsUserInfo()).token).toBe(ORGS_USER_INFO)
})

test("expires soon at 20% of a short lifetime and at 10 minutes of a long one", () => {
  expect(expiresSoon({ token: "", issuedAt: 0, expiresAt: 60_000 }, 47_000)).toBe(false)
  expect(expiresSoon({ token: "", issuedAt: 0, expiresAt: 60_000 }, 48_000)).toBe(true)
  expect(expiresSoon({ token: "", issuedAt: 0, expiresAt: 3_600_000 }, 2_999_000)).toBe(false)
  expect(expiresSoon({ token: "", issuedAt: 0, expiresAt: 3_600_000 }, 3_000_000)).toBe(true)
})
