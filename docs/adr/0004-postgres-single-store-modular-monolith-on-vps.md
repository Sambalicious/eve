# 0004. One Postgres store and a two-process modular monolith on a single VPS

Date: 2026-10-16
Status: Accepted (Candidate decision, 2026-10-16)

## Context

ADR 0001 puts all side effects in one NestJS backend. The backend must enforce, under concurrency, a cap of five automatic submissions per WAT day, no duplicate requisitions, a USD 50 monthly spend ceiling, and exactly-once submission claims. Hosting is part of that USD 50. Managed databases cost USD 6 to 38 a month on the platforms checked (Render, Fly.io). Mastra's built-in scheduler and a headless browser both need a long-lived host. Details and sources are in `epics/active/EPIC-0001-job-application-assistant/architecture.md`.

## Decision

- PostgreSQL 17 is the only system of record. It also backs the job queue (`pg-boss`), sessions, and the spend ledger. It runs self-hosted in the same Docker Compose stack.
- `apps/api` builds one image that runs as two processes: `api` (dashboard static files and the authenticated REST API) and `worker` (scheduled and queued jobs, Playwright Chromium, Gmail polling, notification sending). They coordinate only through Postgres rows, row locks, and `LISTEN/NOTIFY`.
- Deployment target: one VPS with at least 2 vCPU and 4 GB RAM, with Caddy for TLS. Postgres and the document volume are backed up off-box nightly, and backups are kept at most 30 days.

## Alternatives rejected

- Microservices or separate deployables: more hosting cost, and the transactions behind the cap, duplicates, and spend would be split.
- Serverless functions: no long-lived scheduler, and per-invocation Chromium.
- Redis or Inngest as the queue: a second store, so the exactly-once guarantee would span two systems.
- Managed Postgres: its cost leaves too little of the ceiling for AI.
- A single process: one hung Chromium would take the dashboard down with it.

## Consequences

- Every concurrency rule is a provable Postgres transaction.
- The Candidate's installation owns database operations: upgrades, backups, and restore drills.
- One host is a single point of failure. A restart is safe because boot recovery moves in-flight submissions to Uncertain Submission (ADR 0005).
- Moving to a managed queue or database later means re-proving the transactional guarantees.
