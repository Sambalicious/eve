# 0002. pnpm workspace monorepo run by Turborepo

Date: 2026-10-16
Status: Accepted (Candidate decision)

## Context

The dashboard and backend share domain types (Application, Eligibility, Job Posting) and must agree on one API contract. Keeping them in separate repositories would mean publishing and versioning that contract.

## Decision

- One repository, managed as a pnpm workspace (`pnpm-workspace.yaml`), pinned to pnpm 10.14.0 through `packageManager`.
- Turborepo (`turbo.json`) runs `build`, `typecheck`, `lint`, `test`, and `dev` across packages, caching outputs in `dist/`.
- Deployable apps live in `apps/` (`apps/web`, `apps/api`). Shared code lives in `packages/` (for example, the API contract and domain types), and apps import it as `workspace:*` dependencies.
- The AI team (`.agents/`, `factory/`, `AGENTS.md`) stays at the repository root, outside the workspace.

## Consequences

- A contract change and both sides of it land in one commit, and `turbo run typecheck` checks both.
- Every package needs `build`, `typecheck`, and `lint` scripts with matching names, or Turborepo skips it silently.
- Deploys build a single app with `turbo run build --filter=<app>`.
