/**
 * The claims of a JWT. The signature is not checked: the tank only reads tokens that a server issued to it.
 */
export function jwtClaims(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1]
  if (payload === undefined || payload === "") {
    throw new Error("The value is not a JWT")
  }
  const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
    throw new Error("The JWT payload is not a JSON object")
  }
  return claims as Record<string, unknown>
}

/** The `exp` claim in epoch milliseconds, or `undefined` when the value is not a JWT with one. */
export function jwtExpiresAt(jwt: string): number | undefined {
  try {
    const exp = jwtClaims(jwt).exp
    return typeof exp === "number" ? exp * 1000 : undefined
  }
  catch {
    return undefined
  }
}

export function stringClaim(claims: Record<string, unknown>, name: string): string | undefined {
  const value = claims[name]
  return typeof value === "string" ? value : undefined
}
