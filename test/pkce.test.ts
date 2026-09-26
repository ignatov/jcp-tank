import { expect, test } from "bun:test"
import { pkceChallenge, pkceVerifier } from "../src/pkce"

test("computes the S256 challenge of RFC 7636 appendix B", () => {
  expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
})

test("makes a verifier of 43 unreserved characters", () => {
  expect(pkceVerifier()).toMatch(/^[A-Za-z0-9_-]{43}$/)
})
