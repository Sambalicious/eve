# 0014. Advanced is a server-stored, visibility-only flag with an enforced `automatic implies advanced` invariant

Date: 2026-11-08
Status: Accepted.

## Context

EPIC-0011 hides the automation surface from most Candidates. The web shell needs to know whether a Candidate uses Advanced before it paints, on every device (AC-3.8). If it guesses, Advanced items flash and then vanish, or stay hidden for someone who wants them.

Two wrong stores were considered. Per-device state (a cookie or `localStorage`) cannot meet "every device". `activation_state` looks convenient, but that row only exists for Candidates the submission slice seeded. Its RLS and grants belong to the submission module. A visibility flag sitting in a submission table invites someone to read it as automation state.

There is also a safety rule. Advanced off must mean automation off. The UI alone cannot hold that rule, because any client can call the API directly.

## Decision

- The flag is its own table, `candidate_view_setting`. One row per Candidate. `candidate_id` is the primary key and a foreign key `on delete cascade`. It has forced RLS with the `<table>_candidate` policy used by 0022 and 0024, so one Candidate cannot read or write another's row.
- Columns: `advanced_enabled bool not null default false`, `simpler_note_due bool not null default false`, `improve_list_dismissed_at timestamptz null`, `updated_at timestamptz not null`. A missing row reads as the defaults, so invite creation needs no seeding.
- Migration `0033-simplify-eve` creates the table, enables and forces RLS, and adds the policy. It seeds one row per existing Candidate:
  - `role = 'operator'` gets `advanced_enabled = true` and `simpler_note_due = false`.
  - Every other existing Candidate (`state = 'active'`) gets `advanced_enabled = false` and `simpler_note_due = true`.
  - Candidates created later get no row, which reads as off with no note.
  - This is the only rule. There is no automation detection.
- `GET /v1/me` gains four required keys: `advancedEnabled`, `advancedLocked`, `simplerNoteDue` and `improveListDismissed`. `advancedLocked` equals `activation_state.automatic_enabled`, and is false when no row exists. `meResponseSchema` stays `.strict()`. The shell renders no Advanced items until `/v1/me` settles, and falls back to off when it fails.
- `PUT /v1/me/advanced` takes `{enabled: boolean}` and returns the new `/v1/me` body. It refuses with 409 `advanced_locked` when `enabled: false` and `automatic_enabled` is true.
- The invariant holds in both directions. `PUT /v1/submission/automatic {enabled: true}` upserts `advanced_enabled = true` in the same transaction. `enabled: false` never touches the flag.
- Both writers lock `activation_state` `FOR UPDATE` first, then `candidate_view_setting`. This places `activation_state → candidate_view_setting` after controls in the existing lock order. A missing `activation_state` row means unlocked. One lock order means two concurrent writers cannot deadlock or race.
- Hidden routes keep their paths. Each Advanced-only page renders wrapped in `advanced-route-note`, which shows the page plus a one-line note and "Turn on Advanced" when the flag is off. Nothing is withheld from someone who arrives by a link.

## Alternatives rejected

- **The flag in `localStorage` or a cookie.** It is per-device, so it breaks "every device" (AC-3.8). It is also client-held state, and the invariant would have no server-side home.
- **The flag as a column on `activation_state`.** That row only exists for the Candidates the submission slice seeded, so Candidates it never seeded would have no row. Its RLS and grants belong to the submission module. Worst of all, a visibility flag in a submission table reads as automation state.
- **A UI-only lock on turning Advanced off.** It can be bypassed by calling the API, so a Candidate could turn Advanced off while automatic submission stayed on. That is the silent automation risk.
- **Enforcing only `automatic ⇒ advanced`, not the reverse.** An API call could then turn automatic on while Advanced stayed off, and the invariant would be broken in the other direction.

## Consequences

- A missing row is a safe default. Invites need no seeding, and a new Candidate starts with Advanced off.
- The read is one primary-key row per page load, and only when the 5-minute `viewer` cache is stale.
- Every future feature that turns automation on must go through the same lock order.
- The table is easy to reverse: dropping it breaks nothing else, because nothing else reads it. Migration `0033-simplify-eve` `down` drops the table and restores the four-value Outcome check; it refuses if any `offer` row exists.
- A converted user starts with Advanced off. Needs-you and the pause banner cover the safety cases.
