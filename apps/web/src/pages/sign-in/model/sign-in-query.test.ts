import { describe, expect, it } from "vitest"

import { parseSignInQuery } from "./sign-in-query"

const parse = (query: string) => parseSignInQuery(new URLSearchParams(query))

describe("parseSignInQuery", () => {
  it.each([
    ["error=cancelled", { kind: "failed" }],
    ["error=failed", { kind: "failed" }],
    ["error=account_refused&email=someone.else%40gmail.com", { kind: "refused", email: "someone.else@gmail.com" }],
    ["error=account_refused", { kind: "refused", email: null }],
    ["error=account_refused&email=%20%20", { kind: "refused", email: null }],
    ["reason=expired", { kind: "expired" }],
    ["reason=expired&error=account_refused", { kind: "refused", email: null }],
    ["", null],
    ["error=other&reason=other", null],
  ])("maps %j to its notice", (query, notice) => {
    expect(parse(query).notice).toEqual(notice)
  })

  it("keeps a valid next and replaces an unsafe one with Home", () => {
    expect(parse("next=%2Fblocked%3Fa%3D1%23x").next).toBe("/blocked?a=1#x")
    expect(parse("next=https%3A%2F%2Fevil.example").next).toBe("/dashboard")
  })

  it("keeps next when other parameters are invalid", () => {
    expect(parse("next=%2Fblocked&error=teapot").next).toBe("/blocked")
  })
})
