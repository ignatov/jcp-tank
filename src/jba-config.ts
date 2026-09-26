/** The `<oauth>` block of `JetBrainsAccount.xml`. The IDE reads the same block through `OAuthConfig`. */
export interface JbaOAuthConfig {
  readonly clientId: string
  readonly scope: string
  readonly authEndpoint: string
  readonly tokenEndpoint: string
  readonly orgsUserInfoJwtEndpoint: string
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" }

export function decodeXmlEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name] ?? "")
}

export function parseJbaOAuthConfig(xml: string): JbaOAuthConfig {
  const oauth = /<oauth>([\s\S]*?)<\/oauth>/.exec(xml)?.[1]
  if (oauth === undefined) {
    throw new Error("JetBrainsAccount.xml has no <oauth> block")
  }
  const tag = (name: string): string => {
    const value = new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`).exec(oauth)?.[1]
    if (value === undefined) {
      throw new Error(`JetBrainsAccount.xml has no <oauth><${name}>`)
    }
    return decodeXmlEntities(value)
  }
  return {
    clientId: tag("clientId"),
    scope: tag("scope"),
    authEndpoint: tag("authEndpoint"),
    tokenEndpoint: tag("tokenEndpoint"),
    orgsUserInfoJwtEndpoint: tag("orgsUserInfoJwtEndpoint"),
  }
}

export async function fetchJbaOAuthConfig(url: string): Promise<JbaOAuthConfig> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) {
    throw new Error(`GET ${url} failed: HTTP ${response.status}`)
  }
  return parseJbaOAuthConfig(await response.text())
}
