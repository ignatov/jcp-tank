import type { JcpEnvironment } from "./env"
import type { JbaOAuthConfig } from "./jba-config"
import { jwtExpiresAt } from "./jwt"
import type { SecretStore } from "./secrets"

export const AGENT_SPAWNER_AUDIENCE = "jcp-agent-spawner"
export const ORG_SERVICE_AUDIENCE = "org-service"

/** The durable credential: the tank's own refresh token and the identity that it belongs to. */
export interface RefreshData {
  readonly refreshToken: string
  readonly subject: string
  readonly issuer: string
}

/** An access token with the moments it was issued and expires, in epoch milliseconds. */
export interface IssuedToken {
  readonly token: string
  readonly issuedAt: number
  readonly expiresAt: number
}

/** The tank has no usable refresh token. Only `jcp-tank login` fixes this. */
export class AuthRequiredError extends Error {
  override readonly name = "AuthRequiredError"
}

/** A token request that failed but did not reject the credential: a network fault or a server error. */
export class TokenRequestError extends Error {
  override readonly name = "TokenRequestError"

  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

const EXPIRES_SOON_ABSOLUTE_MS = 10 * 60_000
const EXPIRES_SOON_TTL_FRACTION = 0.2
const REQUEST_TIMEOUT_MS = 30_000

/** True when the token expires within min(10 min, 20% of its lifetime). This is `JBAManager.CachedToken.expiresSoon`. */
export function expiresSoon(token: IssuedToken, now: number): boolean {
  const lead = Math.min(EXPIRES_SOON_ABSOLUTE_MS, (token.expiresAt - token.issuedAt) * EXPIRES_SOON_TTL_FRACTION)
  return now + lead >= token.expiresAt
}

export function refreshSecretName(env: JcpEnvironment): string {
  return `jba-refresh:${env.name}`
}

export function spawnerSecretName(env: JcpEnvironment, workspaceId: string): string {
  return `spawner-token:${env.name}:${workspaceId}`
}

/**
 * Mints org tokens from the tank's refresh token, the same way as `JBAManager.getOrgAccessToken`: an
 * `org-service` token, then the orgs-user-info JWT, then a `switch_audience` grant scoped to a workspace.
 */
export class TokenMinter {
  private readonly inflight = new Map<string, Promise<IssuedToken>>()

  constructor(
    private readonly env: JcpEnvironment,
    private readonly oauth: JbaOAuthConfig,
    private readonly secrets: SecretStore,
    private readonly now: () => number = Date.now,
  ) {}

  async loadRefreshData(): Promise<RefreshData> {
    const stored = await this.secrets.get(refreshSecretName(this.env))
    if (stored === null) {
      throw new AuthRequiredError("No refresh token is stored. Run `jcp-tank login`.")
    }
    return JSON.parse(stored) as RefreshData
  }

  async saveRefreshData(data: RefreshData): Promise<void> {
    await this.secrets.set(refreshSecretName(this.env), JSON.stringify(data))
  }

  /**
   * A token for the audience, scoped to a workspace when `org` is given. The server can rotate the refresh
   * token in the response. The tank then saves the new one, and the old one stays valid until it expires.
   */
  async switchAudience(audience: string, org?: { readonly workspaceId: string, readonly orgsUserInfo: string }): Promise<IssuedToken> {
    const refresh = await this.loadRefreshData()
    const form = new URLSearchParams({
      grant_type: "switch_audience",
      client_id: this.oauth.clientId,
      refresh_token: refresh.refreshToken,
      audience,
    })
    if (org !== undefined) {
      form.set("workspace_id", org.workspaceId)
      form.set("orgs_user_info", org.orgsUserInfo)
    }
    const issuedAt = this.now()
    const body = await this.request(`switch_audience to '${audience}'`, this.oauth.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form,
    }, true)
    const json = parseJsonObject(body, "The token endpoint")
    const accessToken = json.access_token
    if (typeof accessToken !== "string") {
      throw new TokenRequestError("The token endpoint response has no access_token")
    }
    const rotated = json.refresh_token
    if (typeof rotated === "string" && rotated !== refresh.refreshToken) {
      await this.saveRefreshData({ ...refresh, refreshToken: rotated })
    }
    return { token: accessToken, issuedAt, expiresAt: expiresAt(json.expires_in, accessToken, issuedAt) }
  }

  /** The orgs-user-info JWT. Its `orgMemberships` claim lists the organizations and their workspaces. */
  async orgsUserInfo(): Promise<IssuedToken> {
    const orgService = await this.switchAudience(ORG_SERVICE_AUDIENCE)
    const issuedAt = this.now()
    const body = (await this.request("orgs-user-info", this.oauth.orgsUserInfoJwtEndpoint, {
      headers: { Authorization: `Bearer ${orgService.token}`, Accept: "application/json" },
    }, false)).trim()
    // JBAManager reads {jwt, expires_in}. The local JCP stack answers with the bare JWT.
    if (!body.startsWith("{")) {
      return { token: body, issuedAt, expiresAt: expiresAt(undefined, body, issuedAt) }
    }
    const json = parseJsonObject(body, "The orgs-user-info endpoint")
    if (typeof json.jwt !== "string") {
      throw new TokenRequestError("The orgs-user-info response has no jwt")
    }
    return { token: json.jwt, issuedAt, expiresAt: expiresAt(json.expires_in, json.jwt, issuedAt) }
  }

  /**
   * The `jcp-agent-spawner` token for the workspace. The tank reuses a cached token until it expires soon.
   * Concurrent callers share one mint.
   */
  spawnerToken(workspaceId: string, options: { readonly force?: boolean } = {}): Promise<IssuedToken> {
    const running = this.inflight.get(workspaceId)
    if (running !== undefined && options.force !== true) {
      return running
    }
    const mint = this.cachedOrMinted(workspaceId, options.force === true)
      .finally(() => this.inflight.delete(workspaceId))
    this.inflight.set(workspaceId, mint)
    return mint
  }

  private async cachedOrMinted(workspaceId: string, force: boolean): Promise<IssuedToken> {
    const name = spawnerSecretName(this.env, workspaceId)
    if (!force) {
      const cached = await this.secrets.get(name)
      if (cached !== null) {
        const token = JSON.parse(cached) as IssuedToken
        if (!expiresSoon(token, this.now())) {
          return token
        }
      }
    }
    const orgsUserInfo = await this.orgsUserInfo()
    const token = await this.switchAudience(AGENT_SPAWNER_AUDIENCE, { workspaceId, orgsUserInfo: orgsUserInfo.token })
    await this.secrets.set(name, JSON.stringify(token))
    return token
  }

  private async request(what: string, url: string, init: RequestInit, clientErrorRejectsCredential: boolean): Promise<string> {
    let response: Response
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    }
    catch (e) {
      throw new TokenRequestError(`${what} failed: ${(e as Error).message}`)
    }
    const body = await response.text()
    if (response.ok) {
      return body
    }
    // JBAManager: any 4xx from the token endpoint means that the refresh token is no longer accepted.
    if (clientErrorRejectsCredential && response.status >= 400 && response.status < 500) {
      throw new AuthRequiredError(`${what} was rejected with HTTP ${response.status}: ${body}. Run \`jcp-tank login\`.`)
    }
    throw new TokenRequestError(`${what} failed: HTTP ${response.status}: ${body}`, response.status)
  }
}

function parseJsonObject(body: string, source: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(body)
  }
  catch {
    throw new TokenRequestError(`${source} did not answer with JSON: ${body.slice(0, 200)}`)
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TokenRequestError(`${source} did not answer with a JSON object`)
  }
  return value as Record<string, unknown>
}

/** The expiry from `expires_in` in seconds, else from the JWT `exp` claim. */
function expiresAt(expiresIn: unknown, token: string, issuedAt: number): number {
  const seconds = typeof expiresIn === "string" ? Number(expiresIn) : expiresIn
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    return issuedAt + seconds * 1000
  }
  const exp = jwtExpiresAt(token)
  if (exp !== undefined) {
    return exp
  }
  throw new TokenRequestError("The token response has neither expires_in nor a JWT exp claim")
}
