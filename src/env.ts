/** A JCP installation and the JetBrains Account service that issues tokens for it. */
export interface JcpEnvironment {
  /** A short name. It keys the secrets, so the tokens of two installations never mix. */
  readonly name: string
  /** The JCP API host. It serves the agent spawner. */
  readonly jcpUrl: string
  /** The JetBrains Account service configuration: the OAuth client and its endpoints. */
  readonly jbaConfigUrl: string
  /** Air Web, which shows the cloud sessions in a browser. */
  readonly airWebUrl: string
}

/** Production. The values match `AirJcpEnvironment.Production` and `CloudSessionUrl.kt` in the Air plugin. */
export const PRODUCTION: JcpEnvironment = {
  name: "prod",
  jcpUrl: "https://api.jetbrains.cloud",
  jbaConfigUrl: "https://www.jetbrains.com/config/JetBrainsAccount.xml",
  airWebUrl: "https://air.jetbrains.cloud",
}

/** The page of a session in Air Web. */
export function airWebSessionUrl(env: JcpEnvironment, organizationId: string, sessionId: string): string {
  return `${env.airWebUrl}/org/${encodeURIComponent(organizationId)}/session/${encodeURIComponent(sessionId)}/editor`
}

export function spawnerHttpUrl(env: JcpEnvironment): string {
  return `${env.jcpUrl.replace(/\/+$/, "")}/agent-spawner`
}

export function spawnerAcpUrl(env: JcpEnvironment): string {
  return `${spawnerHttpUrl(env).replace(/^https:/, "wss:").replace(/^http:/, "ws:")}/acp`
}
