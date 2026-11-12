# 0010. Invite allowlist with Google sign-in, bound to the Google sub

Date: 2026-10-20
Status: Proposed (EPIC-0002 Architect). Supersedes 0007.

## Context

ADR 0007 allowlisted one Google `sub` from `CANDIDATE_GOOGLE_SUB`. EPIC-0002 adds up to 9 invited Candidates and an Operator role. Invites are created by the Operator for an email address; Eve sends no invite email.

## Decision

- Keep Google OIDC authorization code flow with PKCE, `openid email`, server-side Postgres sessions, `HttpOnly; Secure; SameSite=Lax` cookie, CSRF header, and token-free email links (unchanged from 0007).
- Tables: `candidate (id, email, google_sub unique, role operator|candidate, state active|revoked|deleting)`, `invite (email lower-cased, state pending|consumed|revoked, expires_at = created + 14 days)` with one pending invite per email, `seat_setting (limit 1..10, default 5)`.
- Sign-in decision:
  - `sub` bound to an active Candidate → accept; email is ignored.
  - `sub` bound to a revoked Candidate → refuse.
  - Unbound `sub`, verified email equal to a pending unexpired invite → in one transaction lock the invite, create the Candidate with this `sub`, consume the invite, start onboarding and the session.
  - Otherwise refuse; show email only if verified; log reason code only.
- (r1, D4) Refusals carry a specific reason: `not_invited`, `invite_expired`, `email_mismatch`, `revoked` or `unverified_email`. The unverified case never shows the email.
- (r1, D3) An invite for a revoked, undeleted Candidate's email records `restore_candidate_id`. If the same `sub` accepts it, the existing Candidate becomes active again with its data intact. A different `sub` is refused with `email_mismatch` and the invite stays pending. Revocation sets the Operator pause, so restored work does not submit until it is lifted. A revoked Candidate holds no seat.
- Seats (active Candidates + pending invites) are checked at invite creation, not at acceptance.
- Sessions carry `candidate_id`; revocation deletes them in the same transaction and stops the Candidate's jobs.
- Exactly one Operator (partial unique index). Operator routes return 404 to everyone else. The Operator cannot revoke or delete themselves.
- `CANDIDATE_GOOGLE_SUB` is read once by the multi-Candidate migration to bind the owner as Operator; afterwards boot fails if it is set.
- Recovery: host-only CLI `operator:rebind-sub <sub>` running as the DB owner role. No HTTP route.

## Alternatives rejected

- Signed invite links: a bearer token in a shared URL can be forwarded; the allowlist plus verified email needs no secret.
- Matching by email on every sign-in: a changed or recycled Google email could take over an account.
- Separate Operator account: the owner is also a Candidate; one identity is simpler.

## Consequences

- A Candidate who loses their Google account needs the Operator to delete and re-invite them (no self-recovery in MVP). (r1) Restoring an account requires the same Google account (D3).
- Invite acceptance depends on Google's `email_verified` claim.
