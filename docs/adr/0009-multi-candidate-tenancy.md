# 0009. Multi-Candidate tenancy: candidate_id with Postgres row-level security

Date: 2026-10-20
Status: Proposed (EPIC-0002 Architect). Amends 0004.

## Context

EPIC-0002 makes Eve an invite-only installation for up to 10 Candidates on one VPS. Each Candidate's career data must be isolated, and cross-Candidate access must return 404. The schema (21 tables) assumes one Candidate: singleton tables, global unique keys, and a `job_posting` row that mixes shared facts with one Candidate's verdict. The api and worker already connect as a non-owner runtime role created `nobypassrls` (`database-roles.ts`).

## Decision

- Every Candidate-data table gets `candidate_id uuid not null` (FK to `candidate`, `on delete cascade`, leading index). Singletons are re-keyed by `candidate_id`; global unique keys become per-Candidate.
- Each such table has RLS enabled and a policy `candidate_id = nullif(current_setting('eve.candidate_id', true), '')::uuid` for `using` and `with check`. An unset setting matches no rows.
- `TenantDatabase.forCandidate(id, fn)` opens a transaction and calls `set_config('eve.candidate_id', id, true)` (transaction-local). Candidate repositories accept only the resulting `CandidateTx`. The raw database handle is lint-restricted to `db/`, shared-data repositories, auth and the Operator module.
- The api takes `candidateId` only from the session; the worker only from the job payload via `CandidateJobRunner`.
- `job_posting` keeps shared facts (extracted once). Per-Candidate state moves to `candidate_posting`; Eligibility and Match re-key to `(candidate_id, job_posting_id)`.
- Cross-Candidate reads use owner-defined `security definer` functions only (Operator console metadata, spend reserve/settle, deletion). These are the only RLS bypasses.
- Proof: a catalog test fails if any table with `candidate_id` lacks RLS and its policy; a route-registry test fails if any authenticated route lacks a cross-Candidate 404 case; a fail-closed test asserts zero rows without the setting.
- Files live under `/data/candidates/<candidate_id>/`, resolved only after a scoped DB lookup.

## Alternatives rejected

- App-level scoping only: isolation depends on every query remembering a predicate.
- Schema- or database-per-Candidate: shared posting facts and the global spend ledger need cross-tenant access; N migration runs.
- One Postgres role per Candidate: role management at runtime for no gain over a transaction setting.

## Consequences

- Every repository changes once (slice A), before EPIC-0001 slices 5–7 add more tables.
- New tables must declare their class (Candidate, shared, identity); the catalog test enforces it.
- `security definer` functions need Security review on every change.
- Moving off shared schema later would require migrating every table.
