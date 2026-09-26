import { afterEach, expect, test } from "bun:test"
import type { Server } from "bun"
import type { JbaOAuthConfig } from "../src/jba-config"
import { browserLogin } from "../src/login"
import { pkceChallenge } from "../src/pkce"

let tokenServer: Server<undefined> | undefined

afterEach(() => {
  void tokenServer?.stop(true)
  tokenServer = undefined
})

/** A token endpoint that accepts the code only with the verifier of the challenge it saw. */
function oauthWithTokenEndpoint(challenges: Map<string, string>, exchanges: URLSearchParams[]): JbaOAuthConfig {
  tokenServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const form = new URLSearchParams(await request.text())
      exchanges.push(form)
      if (pkceChallenge(form.get("code_verifier") ?? "") !== challenges.get(form.get("code") ?? "")) {
        return Response.json({ error: "invalid_grant" }, { status: 400 })
      }
      return Response.json({ access_token: "access", refresh_token: "refresh", id_token: "id", expires_in: 3600 })
    },
  })
  return {
    clientId: "ide",
    scope: "openid offline_access r_ide_auth",
    authEndpoint: "https://account.example/oauth/login",
    tokenEndpoint: `http://127.0.0.1:${tokenServer.port}/oauth2/token`,
    orgsUserInfoJwtEndpoint: "unused",
  }
}

test("completes the PKCE flow through the loopback redirect", async () => {
  const challenges = new Map<string, string>()
  const exchanges: URLSearchParams[] = []
  const oauth = oauthWithTokenEndpoint(challenges, exchanges)
  let pageStatus = 0
  let authorize: URL | undefined

  const tokens = await browserLogin(oauth, {
    ports: [],
    openBrowser: async (url) => {
      authorize = new URL(url)
      challenges.set("the-code", authorize.searchParams.get("code_challenge")!)
      const redirect = new URL(authorize.searchParams.get("redirect_uri")!)
      redirect.searchParams.set("code", "the-code")
      redirect.searchParams.set("state", authorize.searchParams.get("state")!)
      // The browser follows the redirect in its own time; the login must not wait for this fetch.
      void fetch(redirect).then((response) => pageStatus = response.status)
    },
  })

  const seen = authorize!
  expect(tokens).toEqual({ accessToken: "access", refreshToken: "refresh", idToken: "id" })
  expect(seen.origin + seen.pathname).toBe("https://account.example/oauth/login")
  expect(seen.searchParams.get("client_id")).toBe("ide")
  expect(seen.searchParams.get("scope")).toBe("openid offline_access r_ide_auth")
  expect(seen.searchParams.get("code_challenge_method")).toBe("S256")
  expect(seen.searchParams.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+$/)
  expect(Object.fromEntries(exchanges[0]!)).toMatchObject({
    grant_type: "authorization_code",
    code: "the-code",
    client_id: "ide",
    redirect_uri: seen.searchParams.get("redirect_uri"),
  })
  await Bun.sleep(50)
  expect(pageStatus).toBe(200)
})

test("ignores a redirect with a foreign state and keeps waiting", async () => {
  const oauth = oauthWithTokenEndpoint(new Map(), [])
  let foreignStatus = 0

  const login = browserLogin(oauth, {
    ports: [],
    timeoutMs: 300,
    openBrowser: async (url) => {
      const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!)
      redirect.searchParams.set("code", "stolen")
      redirect.searchParams.set("state", "foreign")
      foreignStatus = (await fetch(redirect)).status
    },
  })

  await expect(login).rejects.toThrow("No login within")
  expect(foreignStatus).toBe(400)
})

test("fails with the error that the authorization server returns", async () => {
  const oauth = oauthWithTokenEndpoint(new Map(), [])

  const login = browserLogin(oauth, {
    ports: [],
    openBrowser: async (url) => {
      const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!)
      redirect.searchParams.set("error", "access_denied")
      redirect.searchParams.set("error_description", "The user said no")
      void fetch(redirect)
    },
  })

  await expect(login).rejects.toThrow("access_denied: The user said no")
})
