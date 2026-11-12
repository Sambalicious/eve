# 0001. Vite dashboard with a NestJS-on-Fastify backend

Date: 2026-10-16
Status: Accepted (Candidate decision)

## Context

The assistant needs a private dashboard plus a long-running backend for scheduled discovery, Mastra AI workflows, browser automation, Gmail tracking, and email. The dashboard template ships both Next.js and Vite versions.

## Decision

- Dashboard: the Vite version of `shadcnstore/shadcn-dashboard-landing-template` (commit 953300f), in `apps/web/`. It is a static single-page app with no server code.
- Backend: NestJS using the Fastify adapter, in `apps/api/`. Mastra AI runs inside this service. All submission rules, caps, spending limits, and duplicate checks live in ordinary backend code, not in model prompts.

## Consequences

- One server process owns scheduling, secrets, and side effects; the dashboard never holds credentials.
- Next.js server features (route handlers, server actions) are unavailable by design.
- Hosting must run a persistent Node process and a browser within the USD 50 monthly ceiling. Feasibility is checked before deployment.
