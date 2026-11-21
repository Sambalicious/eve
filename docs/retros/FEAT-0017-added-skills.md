# FEAT-0017 retro: added skills and experience

Date: 2026-11-21. Scope: the full pipeline from PRD to the live deploy, the port to eve (PR #75) and the first owner bug.

## Outcome

- Merged on eve-factory (#187) and on eve (#75), both by the owner. Deployed to the local live stack with migration 0042, and the flag is now on.
- 4 gates (QA, design, security, code review), each with a repair wave. The port to eve passed a separate Opus review. 14 of 14 Claude dispatches used.
- Worker tier: 18 tasks, 2 rewrites (rewrite rate 2/18), 4 lead self-fixes, 3 advisor consults.

## What went well

- **The gates found real defects, not style.** QA found a stray space in a tick label, a `down` migration that broke under forced RLS, and a missing confirm guard. Security found SEC-R01 and SEC-R06. Code review found CR-1 (U+FFF9–FFFB), which also reopened SEC-R01. All were fixed before merge.
- **The port held.** Eve had refactored the truth guard, generation and the submission queue. The worker put the feature onto eve's structure instead of forcing the old shape, and Opus found no behavioural difference.
- **The deploy followed the runbook,** including stopping when the backup failed instead of migrating without one.

## What went wrong

| # | What happened | Cost | Root cause |
|---|---|---|---|
| 1 | Declared VERIFIED before a combined recheck | The advisor reverted it, and one extra recheck ran | Treated per-wave checks as the final candidate's evidence |
| 2 | Recheck 1 missed a red `cross-candidate-registry` introduced by wave 1 | Found 4 waves later, by a worker | Recheck scope was the touched files, but a registry spec covers files the wave never touched |
| 3 | PRs opened on eve-factory twice (#187, #188) instead of eve | Owner asked twice; one PR closed | Pushed to `origin` without checking which repo the owner works in |
| 4 | 53 screenshots committed as folders | An extra commit, and images re-hosted by hand | Followed the factory's review convention over the owner's stated preference |
| 5 | e2e passed locally, failed on CI (`added-skills-tick:298`) | One worker task | The assertion matched copy rendered twice on screen; local timing hid the race |
| 6 | After a Regenerate the Added section stayed locked until reload (owner found it) | A live bug and one worker task | Two independently polled queries; no test covered the generating → done transition, and the e2e never regenerated and then added |
| 7 | Owner "couldn't see the feature" after deploy | One round trip | I reported "flag off" as a step, not as "you will not see it yet" |
| 8 | Live install had no backups configured at all | Deploy paused; key, role and password set up mid-deploy | Backups were never part of setup; nothing alerts on a failed backup |
| 9 | Rollback image lost | No image to roll back to | `docker compose build` overwrites `eve-api:local`; the runbook says to record the rollback image but never tags it |
| 10 | eve-factory CI dead since 2026-11-20 (billing) | #187 merged with no CI; nobody noticed | CI failure is read per PR, not watched on `main` |
| 11 | A ledger row landed in a stray `FEAT-0017-job-added-skills/` at the repo root | Manual move | `ledger.mjs --run` resolves a bare name against the cwd, not `features/active/` |
| 12 | I pointed a worker at a cancelled CI run | The worker found the real run itself | Took the run ID from the check list without checking its conclusion |

## Actions

| Action | Type | Owner |
|---|---|---|
| Check the target repo before every push; PRs go to eve only | Done (memory `pr-target-eve`) | Lead |
| Screenshots go in the PR description, never in committed folders | Done (memory `pr-screenshots`) | Lead |
| A recheck also runs the registry and guard specs (`cross-candidate-registry`, `converted-feature-guard`) whenever a wave touches a route or a guard | Done (factory: `pnpm agents:recheck` and `.agents/recheck-always.json`) | Lead |
| A UI test for every state transition that gates an action (generating → done here), not only the steady states | Done (factory: QA `[5e]` checklist) | QA |
| e2e assertions on copy that can render twice address the region (form, alert), not the text | Done (factory: QA `[5e]` checklist) | QA |
| Deploy runbooks tag the running image as `eve-api:rollback` before `docker compose build` | Done (eve #76) | DevOps |
| Setup configures `BACKUP_AGE_RECIPIENT` and the backup role; a failed backup shows on the dashboard | Feature follow-up | PM |
| The deploy report says plainly what the owner will and will not see with the flag off | Process | Lead |
| Fix the GitHub billing so eve-factory CI runs again | Owner | Owner |
| Fix `ledger.mjs --run` path resolution and `artifacts.mjs` reviews path | Done (factory: `run-path.mjs`) | Worker |

## Still open from the feature

- CR-4: `requeueAtsHeld` can requeue a lifted Application whose confirmation was voided (the claim drops it, so nothing unconfirmed is sent). Fix in progress.
- Stored Outreach records keep the text of a removed blocked sentence (FEAT-0014 scope).
- `stack-feed-scheduled-reads` SFS:279 flake, not in `known-failures.md`.
- e2e `ENOENT` log noise for fixture storage roots.

## Metrics

| metric | value |
|---|---|
| worker_tasks | 18 (regenerate refresh fix; eve CI e2e + nits; eve port; design-spec r1 marker edit; QA authoring [5e]; SEC-001 contract+devops r1; build: contracts; build: backend [5a]; build: frontend [5b]; deploy.md runbook; QA repair wave 1; design repair wave 2; security repair wave 3; code-review repair wave 4; combined recheck; wave 5 web; wave 5 api; combined recheck 2) |
| rewrites | 2 ([5e]: no SEC-001 flag-off tests, 167/322 coverage; [5a]: URL rule added to shared containsContactDetail changes flag-off validator decisions) |
| self_fixes | 4 (gherkin OD-16 / C-AF-51 alignment; five contract spec tails widened for v1.32.0 appends; design-review rulings into spec, gherkin, copy deck; cross-candidate-registry status for guarded confirm); escalation: [5e] authored specs to lead tier (rung 3), repaired in the QA gate session |
| advisor_calls | 3 (orientation before plan; before API contract; before declaring done: combined recheck required) |
| advisor_share | 3/25 |
| rewrite_rate | 2/18 |
