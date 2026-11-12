/** The ID token claims the decision needs, after the OIDC library has verified the token. */
export type VerifiedIdentity = Readonly<{
  sub: string
  email: string | undefined
  emailVerified: boolean
}>

/** The `candidate` row whose `google_sub` equals the token's `sub`, if any. */
export type BoundCandidate = Readonly<{
  id: string
  state: "active" | "revoked" | "deleting"
}>

export type SignInDecision =
  | { kind: "accepted"; candidateId: string; googleSub: string }
  | { kind: "refused"; displayEmail: string | undefined }

/**
 * Only a Google account bound to an active Candidate row may sign in
 * (EPIC-0002 A1: the `candidate` table replaces ADR 0007's single bound sub).
 * The match is on `sub`, never on email. The email is shown back on refusal
 * only when Google says it is verified.
 */
export function decideSignIn(identity: VerifiedIdentity, bound: BoundCandidate | undefined): SignInDecision {
  const displayEmail = identity.emailVerified ? identity.email : undefined
  if (bound === undefined || bound.state !== "active" || !identity.emailVerified) {
    return { kind: "refused", displayEmail }
  }
  return { kind: "accepted", candidateId: bound.id, googleSub: identity.sub }
}
