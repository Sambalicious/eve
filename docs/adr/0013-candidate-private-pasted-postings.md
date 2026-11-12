# 0013. Candidate-private Job Posting rows for pasted descriptions

Date: 2026-11-02
Status: Proposed (EPIC-0010 Architect). Extends 0004 and 0009. Leaves the shared-posting split (EPIC-0002, migration 0019) unchanged for every other origin.

## Context

EPIC-0010 lets a Candidate paste a job description for a posting Eve cannot read, so they can get tailored documents and an ATS score for a Manual Application. `job_posting` is shared: one row per `(application_url, requisition_id)` for every Candidate. The evaluation writes shared facts onto it: `role_family`, `technologies` and `ats_skills`. Every holder also reads `posting_text`. A pasted description is untrusted, Candidate-supplied, and must stay private to that Candidate (PRD PD-2.6), even when two Candidates paste the same link.

## Decision

- A pasted description is stored as its own `job_posting` row:
  - `origin = 'pasted_description'`;
  - `owner_candidate_id` set to the pasting Candidate;
  - `apply_mode = 'manual'`;
  - `requisition_id = 'pasted:<id>'`;
  - `application_url` set to the normalised link, or `urn:eve:pasted:<id>` when there is no link.

  Exactly one `candidate_posting` row, the owner's, holds it.
- CHECK constraints make `pasted_description` ⇔ owner set ⇒ `apply_mode = 'manual'` an invariant of the database. Every submission path refuses `apply_mode = 'manual'`.
- `job_posting` gets forced row-level security with one policy, the same for `using` and `with check`: `owner_candidate_id is null or (owner_candidate_id = (select public.bound_candidate()) and owner_candidate_id = nullif(current_setting('eve.candidate_id', true), '')::uuid)`. This is the migration 0022 Candidate-binding pattern. Shared rows are unaffected in every scope. Owned rows are invisible outside their owner's bound scope. Amended 2026-11-07 (SEC-R-06 / CR-02).
- Migration `0031-pasted-description` adds all of this. Its `down` is lossless: it removes the policy first, then relabels the rows as `pasted_link` (still `manual`) before restoring the old CHECKs.

## Alternatives rejected

- **Text in a separate Candidate table, shared posting row kept.** Evaluation would still write derived keywords and the role family onto the shared row, leaking them across Candidates and letting one Candidate's text change another's score. Preventing that means forking `recordEvaluation`, the list SQL and the ATS reads.
- **A separate "manual job" entity.** It would duplicate the Application, document, ATS and Eligibility paths the owner asked to reuse.
- **Privacy by the `candidate_posting` join alone, no RLS.** Some reads select `job_posting` by id without the join. Every other piece of Candidate data in this codebase is behind forced RLS (EPIC-0002).

## Consequences

- The evaluator, documents, ATS score, lists and retention work on pasted descriptions unchanged.
- Every query on `job_posting` runs under the policy. An unscoped or shared-scope job cannot see private rows, so any future job that must reach them has to run in the owner's scope.
- Synthetic keys are persisted in `application` and records. The API maps the URN sentinel to `null` and never sends it.
- Allowing automatic submission of pasted postings later would require dropping a CHECK, a deliberate, reviewable change.
