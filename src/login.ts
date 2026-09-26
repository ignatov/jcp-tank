import type { Server } from "bun"
import type { JbaOAuthConfig } from "./jba-config"
import { oauthState, pkceChallenge, pkceVerifier } from "./pkce"

/** The loopback ports that the IDE uses for the authorization redirect (`AuthTokenManager`). */
export const CALLBACK_PORTS: readonly number[] = Array.from({ length: 19 }, (_, i) => 62345 + i)

const LOGIN_TIMEOUT_MS = 5 * 60_000

/** The tokens of an authorization code exchange. */
export interface CodeExchangeResult {
  readonly accessToken: string
  readonly refreshToken: string
  readonly idToken: string
}

export interface BrowserLoginOptions {
  /** Shows the authorization page to the user. */
  readonly openBrowser: (url: string) => void | Promise<void>
  /** The loopback ports to try in order. The OS picks a port when all of them are busy. */
  readonly ports?: readonly number[]
  readonly timeoutMs?: number
}

/**
 * Signs in to JetBrains Account with the public OAuth client of the IDE: an authorization code with PKCE and
 * a loopback redirect, the same flow as `AuthTokenManager`. The tank gets its own refresh token, so it never
 * shares the token of the IDE.
 */
export async function browserLogin(oauth: JbaOAuthConfig, options: BrowserLoginOptions): Promise<CodeExchangeResult> {
  const verifier = pkceVerifier()
  const state = oauthState()
  const outcome = Promise.withResolvers<CodeExchangeResult>()
  let redirectUri = ""

  const server = serveOnFirstFreePort(options.ports ?? CALLBACK_PORTS, async (request) => {
    if (request.method !== "GET") {
      return new Response("", { status: 405 })
    }
    const query = new URL(request.url).searchParams
    const code = query.get("code")
    if (code === null) {
      const error = query.get("error")
      if (error === null) {
        // A favicon or another stray request, not the redirect.
        return new Response("", { status: 404 })
      }
      const description = query.get("error_description")
      const failure = new Error(`The login failed: ${error}${description === null ? "" : `: ${description}`}`)
      outcome.reject(failure)
      return page(failure.message, 400)
    }
    if (query.get("state") !== state) {
      return page("The login failed: the state is unknown. Run `jcp-tank login` again.", 400)
    }
    try {
      const tokens = await exchangeCode(oauth, code, verifier, redirectUri)
      outcome.resolve(tokens)
      return page("Signed in. Return to the terminal.", 200)
    }
    catch (e) {
      outcome.reject(e as Error)
      return page((e as Error).message, 500)
    }
  })

  try {
    redirectUri = `http://localhost:${server.port}`
    const authorize = new URL(oauth.authEndpoint)
    authorize.searchParams.set("client_id", oauth.clientId)
    authorize.searchParams.set("scope", oauth.scope)
    authorize.searchParams.set("state", state)
    authorize.searchParams.set("code_challenge_method", "S256")
    authorize.searchParams.set("code_challenge", pkceChallenge(verifier))
    authorize.searchParams.set("redirect_uri", redirectUri)
    await options.openBrowser(authorize.toString())
    return await withTimeout(outcome.promise, options.timeoutMs ?? LOGIN_TIMEOUT_MS)
  }
  finally {
    // A graceful stop lets the result page reach the browser.
    void server.stop(false)
  }
}

/** Exchanges an authorization code for tokens (RFC 6749 section 4.1.3, with the PKCE verifier). */
export async function exchangeCode(oauth: JbaOAuthConfig, code: string, verifier: string, redirectUri: string): Promise<CodeExchangeResult> {
  const response = await fetch(oauth.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: oauth.clientId,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`The code exchange failed: HTTP ${response.status}: ${body}`)
  }
  const json = JSON.parse(body) as Record<string, unknown>
  const { access_token: accessToken, refresh_token: refreshToken, id_token: idToken } = json
  if (typeof refreshToken !== "string") {
    throw new Error("The code exchange returned no refresh_token. The scope must contain offline_access.")
  }
  if (typeof accessToken !== "string" || typeof idToken !== "string") {
    throw new Error("The code exchange returned no access_token or id_token")
  }
  return { accessToken, refreshToken, idToken }
}

/** Opens the URL in the default browser of macOS. */
export function openInBrowser(url: string): void {
  Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" })
}

function serveOnFirstFreePort(ports: readonly number[], fetch: (request: Request) => Promise<Response>): Server<undefined> {
  for (const port of [...ports, 0]) {
    try {
      return Bun.serve({ hostname: "127.0.0.1", port, fetch })
    }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw e
      }
    }
  }
  throw new Error("No loopback port is free for the login redirect")
}

function page(message: string, status: number): Response {
  const text = message.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c)
  return new Response(`<!doctype html><meta charset="utf-8"><title>jcp-tank</title><p>${text}</p>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  })
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No login within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  }
  finally {
    clearTimeout(timer)
  }
}
