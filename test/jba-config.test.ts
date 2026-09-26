import { expect, test } from "bun:test"
import { parseJbaOAuthConfig } from "../src/jba-config"

test("reads the oauth block of the production JetBrainsAccount.xml", async () => {
  const xml = await Bun.file(new URL("./fixtures/JetBrainsAccount.xml", import.meta.url)).text()

  expect(parseJbaOAuthConfig(xml)).toEqual({
    clientId: "ide",
    scope: "openid offline_access r_ide_auth",
    authEndpoint: "https://account.jetbrains.com/oauth/login",
    tokenEndpoint: "https://oauth.account.jetbrains.com/oauth2/token",
    orgsUserInfoJwtEndpoint: "https://api.jetbrains.cloud/org/orgsuserinfo/extended",
  })
})

test("names the tag that the config does not have", () => {
  const xml = "<config><oauth><clientId>ide</clientId></oauth></config>"

  expect(() => parseJbaOAuthConfig(xml)).toThrow("<oauth><scope>")
})
