# 0007. Dashboard sign-in with Google, allowlisted to the Candidate

Date: 2026-10-16
Status: Accepted (Candidate decision, 2026-10-16)

## Context

The dashboard must serve no data to unauthenticated requests, hold no credentials, and open from links in notification emails (PRD 7.4, 9.1). There is exactly one Candidate. The Candidate already grants Gmail consent through a Google Cloud project (PRD 8.1). Gherkin OQ-G7 asks for the method.

## Decision

- Sign in with Google through the OIDC authorization code flow with PKCE, requesting only `openid email`. The backend accepts only the ID token `sub` stored for the Candidate at installation, which a one-time setup token captures.
- After sign-in the backend creates a server-side session in Postgres and sets a random session ID in an `HttpOnly; Secure; SameSite=Lax` cookie on the dashboard's origin. The idle expiry is 14 days. Mutating requests need a CSRF header that matches the session.
- Links in emails point to authenticated dashboard routes and carry no tokens.
- Recovery: re-running the setup command from the host shell re-binds the Candidate's `sub`.

## Alternatives rejected

- Password with TOTP: the app would store and protect password hashes and build recovery flows for a single user.
- Passkeys alone: more code and a device-loss recovery problem for one person.
- Magic links by email: the sign-in mailbox is the same mailbox the app reads. It also needs the sending path to work before the Candidate can sign in.
- Network-level protection (VPN or tunnel): it needs extra software on every device and doesn't cover email links opened on a phone.

## Consequences

- No password storage. The Candidate's Google 2-step verification protects the dashboard.
- Losing the Google account locks the Candidate out of both Gmail tracking and the dashboard. The host-shell recovery covers this case.
- It uses the Google Cloud project that Gmail consent already needs.
