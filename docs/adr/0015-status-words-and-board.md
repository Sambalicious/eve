# 0015. UI status vocabulary is a web-only, exhaustive mapping over unchanged backend enums; board placement is derived (newest Outcome wins, safety override)

Date: 2026-11-08
Status: Accepted (EPIC-0011 Architect; placement order and schema name follow API contract v1.28.0). Covers D6–D8. Leaves every backend enum and the rest of the API unchanged.

## Context

EPIC-0011 collapses the words the web shows: 8 posting words and about 19 application words each become 5. AC-4.4 forbids renaming backend enums. The Application list also does not return the submission state or the newest Outcome that board placement needs. Building the board from what the list returns today would mean an N+1 fetch of `/applications/:id/submission` and `/outcomes` per card, and the submission route returns 409 for non-Operators. Two questions follow: where the mapping lives, and where placement is computed.

## Decision

- Both mappings are web-only pure functions:
  - `entities/job-posting/model/plain-status.ts`: `postingWord(posting) → {word, reason}`;
  - `entities/application/model/board-column.ts`: `boardColumn(app, {advanced}) → {column, reason, movable}`.
- Each `switch` ends in `assertNever`, and copy maps are typed `satisfies Record<Enum, …>` over the contract enums. Copy keys live in each entity's `model/copy.ts`. Totality turns a new backend enum value into a type error instead of a missing word.
- `postingWord()` precedence: `hiddenReason != null` → **Hidden**. `checking` and `waiting_to_be_checked` → **Checking**, with the reason from `waitingReason`. `ranked` → **Good match**. `skipped` and `excluded` → **Not a match**, with the reason from `skipReason` or the violated rule. `evaluation_failed` and `not_checked` → **Couldn't check**, with Check again. `applyMode: manual` is never a badge, only the detail line.
- The list row gains the fields placement needs [API-C4]. `GET /v1/applications` rows (`applicationListItemSchema`; `applicationSummarySchema` stays unchanged, because five other routes reuse it) add `submissionState`, `submissionKind`, `sampleState` (all nullable, existing enums) and `latestOutcome: {id, type, createdAt} | null`. `latestOutcome` is the newest Outcome by `(created_at, id)` whose type is not `request_for_action`. A separate `requestForAction: boolean` is true when the newest Outcome overall is `request_for_action`. All fields come from one lateral join in `documents.service.list`.
- `boardColumn()` is first match wins, over the five columns Draft, Applied, Interview, Offer and Closed:
  1. Safety override: `submissionState ∈ {blocked, uncertain}` or `sampleState = awaiting_review` → **Needs you**, whatever the flag (AC-3.7). An item that needs action is never buried under an Outcome.
  2. `latestOutcome.type`: `offer` → **Offer**, `interview_invitation` → **Interview**, `rejection` → **Closed**, `confirmation` → **Applied**. The newest Outcome wins (AC-6.2).
  3. `submissionState`: `manual` or `confirmed` → **Applied**. `declined` or `not_submitted` → **Closed**. `queued`, `submit_claimed` or `submitting` → **Sending** when Advanced is on, and **Draft** with a "waiting to send automatically" reason when it is off.
  4. Otherwise **Draft**, with the reason from `state`: generating, blocked or failed documents.
- `requestForAction` adds the "Employer asked for something" line in whatever column the card is in.
- Moves resolve through one pure function, `moveAction(card, target) → manualComplete | createOutcome(type) | editOutcome(id, type) | refused(reason)`, in `features/move-application`. Column order is Draft < Applied < Interview < Offer, and Closed is terminal. Forward moves and moves into Closed **create** an Outcome, so history stays true. Backward moves and moves out of Closed **edit** the placing Outcome to the target's type, where Applied = `confirmation`. Draft → Applied is `manualComplete`, behind a confirm saying it can't be undone.

## Alternatives rejected

- **Renaming backend enums or adding a "board column" field on the server.** AC-4.4 forbids it, and column placement is presentation that will keep changing.
- **A new "not a match" postings tab on the server.** Two existing tab queries already cover it, so no contract change is needed.
- **Deriving the board from the list as it exists today.** It returns neither the submission state nor the newest Outcome, so each card would need its own `/applications/:id/submission` and `/outcomes` fetch, and the submission route returns 409 for non-Operators.

## Consequences

- One function per entity is the only place the mapping lives, which also makes the AC-4.7 copy audit tractable.
- A new backend enum value fails the type check instead of rendering blank.
- The board needs API-C4. Those fields are additive and read-only, and cost one lateral join per Application on an already unpaged list.
- Moves need no new endpoint, because AC-6.5 limits them to existing ones. No Outcome delete endpoint exists, so editing corrects a mistaken move without inventing an event.
- All three decisions are easy to reverse: code only, plus one additive contract change.
