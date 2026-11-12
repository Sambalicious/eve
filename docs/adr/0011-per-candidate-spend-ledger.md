# 0011. Per-Candidate and global spend ledger with locked reservations

Date: 2026-10-20
Status: Proposed (EPIC-0002 Architect). Amends 0004 and 0006.

## Context

EPIC-0001 planned one monthly cost ceiling for one Candidate; only token metering (`ai_call`) and a `cost_paused` flag exist today. EPIC-0002 needs a global monthly ceiling (default USD 50, raisable to USD 100 for the current month) and per-Candidate ceilings (default USD 5), checked before every paid action, safe when several worker jobs spend at once, with overshoot at most one action's estimate error.

## Decision

- Tables: `spend_month` (global counters per UTC month: ceiling, raised ceiling, reserved, settled), `candidate_spend_month` (per Candidate and month: ceiling, reserved, settled), `spend_entry` (kind candidate|shared, candidate_id nullable, purpose, estimate, actual, state reserved|settled|released).
- Every paid action calls `reserve(kind, candidateId, purpose, estimate)` before spending and `settle(entry, actual)` or `release(entry)` after. These are owner-defined `security definer` SQL functions.
- `reserve` locks `spend_month` then `candidate_spend_month` with `select ... for update` in that fixed order, checks `reserved + settled + estimate` against each ceiling, then increments `reserved` and inserts the entry. Shared costs lock only the global row.
- Refusal reason `global_ceiling` sets the global cost pause and notifies the Operator and every affected Candidate. `candidate_ceiling` pauses that Candidate only and notifies them. Pauses clear at 00:00 UTC on the 1st for every Candidate, including the Operator (r1, D5), or when the Operator raises a ceiling. When a raised global ceiling expires, Candidate ceilings above the new global ceiling are lowered to it and the change is audited. Ceilings cannot be set below that month's spend (r1, S2, S3).
- The model gateway (ADR 0006) requires a reservation argument; an unmetered provider call is a type error.
- A sweeper releases reservations older than 30 minutes and reconciles them from `ai_call` token counts.
- On Candidate deletion, entries keep their amounts with `candidate_id` nulled and `deleted_candidate = true`. (r1) Operator audit entries about the Candidate are anonymised the same way.

## Alternatives rejected

- Summing `ai_call` rows at check time without locks: concurrent jobs both see headroom.
- Advisory locks only: works, but row locks on the counter rows also give a cheap, consistent total.
- Redis or an external quota service: new infrastructure for ≤10 Candidates.

## Consequences

- Every paid code path must be estimated up front; estimates need tuning per purpose.
- Global row lock serialises reservations; acceptable at this volume.
- A concurrency test across 3 Candidates against real Postgres guards the invariant.
