import { createHash, randomBytes } from "node:crypto"

/** A PKCE code verifier (RFC 7636): 32 random bytes in base64url. */
export function pkceVerifier(): string {
  return randomBytes(32).toString("base64url")
}

/** The S256 code challenge of the verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

/** An unguessable OAuth `state` value. */
export function oauthState(): string {
  return randomBytes(16).toString("base64url")
}
