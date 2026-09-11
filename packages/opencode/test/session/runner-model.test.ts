import { describe, expect, test } from "bun:test"
import { Auth } from "../../src/auth"
import { legacyCredential } from "../../src/session/runner-model"

describe("SessionRunnerModel compatibility", () => {
  test("adapts legacy API credentials without persisting a new credential", () => {
    expect(legacyCredential(new Auth.Api({ type: "api", key: "secret", metadata: { tenant: "work" } }))).toEqual({
      type: "key",
      key: "secret",
      metadata: { tenant: "work" },
    })
  })

  test("adapts legacy OAuth credentials in memory", () => {
    const credential = legacyCredential(
      new Auth.Oauth({
        type: "oauth",
        refresh: "refresh",
        access: "access",
        expires: 123,
        accountId: "account",
      }),
    )

    expect(credential?.type).toBe("oauth")
    if (credential?.type !== "oauth") return
    expect(String(credential.methodID)).toBe("legacy")
    expect(credential.refresh).toBe("refresh")
    expect(credential.access).toBe("access")
    expect(credential.expires).toBe(123)
    expect(credential.metadata).toEqual({ accountId: "account" })
  })

  test("does not treat well-known configuration tokens as model credentials", () => {
    expect(legacyCredential(new Auth.WellKnown({ type: "wellknown", key: "TOKEN", token: "value" }))).toBeUndefined()
  })
})
