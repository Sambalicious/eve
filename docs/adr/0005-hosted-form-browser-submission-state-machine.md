# 0005. Submit through hosted forms in a browser, guarded by a persisted state machine

Date: 2026-10-16
Status: Accepted (Candidate decision, 2026-10-16)

Amended by ADR 0008 (Proposed): browser work runs through the Playwright MCP server instead of hand-written Playwright scripts, a Mastra form agent fills only leftover fields through backend wrapper tools, and backend code alone performs the final submit click after fill verification. The states and rules below are unchanged.

## Context

Version one submits through Greenhouse, Lever, and Ashby. The Greenhouse application POST endpoint needs the employer's Job Board API key (https://developers.greenhouse.io/job-board.html). The Lever apply POST needs an employer API key (https://github.com/lever/postings-api). Ashby's public posting API is read-only (https://developers.ashbyhq.com/docs/public-job-posting-api). The PRD forbids blind retries, requires an Uncertain Submission state, and counts only evidenced Confirmed Submissions as applied.

## Decision

- Every submission fills the employer's hosted application form in Playwright Chromium. The public job board APIs are used only for discovery and, for Greenhouse, for reading the question schema.
- Each Application moves through persisted states: `prepared`, `documents_ready`, `ready`, then `blocked`, `deferred`, or `submit_claimed`, then `submitting`, then `confirmed` or `uncertain`. `uncertain` resolves to `confirmed` or `not_submitted`.
- `submit_claimed` is set in the same transaction that locks the WAT-day counter row and re-checks pause, cost, the Activation Gate, duplicates, and the same-company rule.
- `submitting` is committed before the final click. It is the point of no return.
- The submission queue has retries off. At boot, every Application in `submit_claimed` or `submitting` becomes `uncertain` and is never re-queued.
- `confirmed` needs positive evidence: a confirmation page, an application ID, or a confirmation email. Evidence is stored with the Application.
- Login, CAPTCHA, email verification, and assessment detection produce `blocked`. There is no bypass.
- Notifications go through a transactional outbox with its own retrying sender, which never imports submission code.

## Alternatives rejected

- ATS POST APIs: they need employer credentials we cannot have.
- Queue-level idempotency only: a crash between the click and the status write would look retryable.
- Retrying on missing confirmation: the PRD forbids it.

## Consequences

- At most one click per Application, even across crashes, pauses, and redeploys.
- Some genuinely successful submissions show as Uncertain Submissions until a confirmation email arrives or the Candidate resolves them.
- The Lever and Ashby adapters depend on DOM structure and will break when forms change. Breakage resolves to blocked or uncertain, never to a false confirmed.
- Application history is stored in these states, so changing them after launch needs a data migration.
