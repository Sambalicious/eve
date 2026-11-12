import { describe, expect, it } from "vitest"

import { type BoundCandidate, decideSignIn } from "./sign-in-decision.js"

const BOUND_SUB = "100000000000000000001"
const OPERATOR: BoundCandidate = { id: "7a0c5f1e-0000-4000-8000-000000000001", state: "active" }

describe("decideSignIn", () => {
  // dashboard.feature: "The Candidate signs in with the Google account bound at installation"
  it("accepts a sub bound to an active Candidate with a verified email", () => {
    expect(
      decideSignIn({ sub: BOUND_SUB, email: "ada.okafor@gmail.com", emailVerified: true }, OPERATOR)
    ).toEqual({ kind: "accepted", candidateId: OPERATOR.id, googleSub: BOUND_SUB })
  })

  // dashboard.feature: "A Google account other than the Candidate's is refused"
  it("refuses a sub bound to no Candidate and returns its verified email for C-AUTH-3", () => {
    expect(
      decideSignIn({ sub: "999", email: "someone.else@gmail.com", emailVerified: true }, undefined)
    ).toEqual({ kind: "refused", displayEmail: "someone.else@gmail.com" })
  })

  it("refuses a revoked or deleting Candidate", () => {
    for (const state of ["revoked", "deleting"] as const) {
      expect(
        decideSignIn({ sub: BOUND_SUB, email: "ada.okafor@gmail.com", emailVerified: true }, { ...OPERATOR, state }).kind
      ).toBe("refused")
    }
  })

  it("refuses the bound sub when Google does not mark the email verified", () => {
    expect(
      decideSignIn({ sub: BOUND_SUB, email: "ada.okafor@gmail.com", emailVerified: false }, OPERATOR)
    ).toEqual({ kind: "refused", displayEmail: undefined })
  })

  it("does not echo an unverified email back to the sign-in page", () => {
    expect(
      decideSignIn({ sub: "999", email: "spoof@example.com", emailVerified: false }, undefined)
    ).toEqual({ kind: "refused", displayEmail: undefined })
  })
})
