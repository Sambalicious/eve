# Eve

[![CI](https://github.com/Sambalicious/eve/actions/workflows/ci.yml/badge.svg)](https://github.com/Sambalicious/eve/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Eve is a personal assistant, built with Mastra AI, that works for one Candidate. It finds remote and relocation software jobs, tailors truthful application documents from the Candidate's approved Career Profile, applies through employer career sites, and reports every submission by email. Eve is open source and self-hosted: one Candidate per installation, your data on your machine. Product rules and domain language are in [CONTEXT.md](CONTEXT.md).

## Quick start

```sh
git clone https://github.com/Sambalicious/eve.git
cd eve
scripts/ops/setup.sh
```

It generates the database passwords and an encryption key for backups, asks for four values you own
(a Google OAuth client, an Anthropic key, and the Gmail address and app password for notifications),
writes a valid `.env`, seeds your account from your Google subject id, starts the stack, and prints
the dashboard URL and the exact OAuth redirect to register.

You need Docker with Compose v2, `openssl`, and `age`. Everything else is in the containers.

No domain is required. `scripts/ops/deploy.sh` puts the same stack on a VPS, and
`docs/ops/deploy-oracle-free.md` walks through a free one.

## Layout

A pnpm and Turborepo monorepo ([ADR 0002](docs/adr/0002-pnpm-turborepo-monorepo.md)):

- `apps/api`: the NestJS backend. One image runs as two processes, `api` and `worker`.
- `apps/web`: the Vite dashboard.
- `packages/contracts`: the shared API contract.

PostgreSQL 17 is the only system of record ([ADR 0004](docs/adr/0004-postgres-single-store-modular-monolith-on-vps.md)).

## Run it

```sh
cp .env.example .env    # then fill in every value; never commit .env
docker compose up --build
```

`docker-compose.yml` starts Postgres, provisions the database roles, runs the migrations, and starts `api`, `worker`, and the submission browser with its egress proxy. Never run `docker compose down -v`: it deletes the live database and files.

Checks for the whole repo:

```sh
pnpm install
pnpm turbo run typecheck lint test build
```

## CI

`.github/workflows/ci.yml` runs on every pull request, on pushes to `main`, and nightly. It needs no secrets and no repository settings.

A first job, `what changed` (`scripts/ci/changes.mjs`), decides which other jobs the diff needs, so CI minutes go only to what could break:

| Change                                                                                                  | Runs                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Docs, epics or agent files only                                                                         | `agent rules`                                                                                                                                |
| A package (`apps/*`, `packages/*`), or a file its code quotes such as an `epics/` copy deck or contract | typecheck, lint and tests for that package and its dependents, plus e2e; the api integration and image jobs only when `@eve/api` is affected |
| Lockfile, root build config, `.github/` or `scripts/ci/`                                                | everything                                                                                                                                   |
| Nightly                                                                                                 | everything, when `main` changed in the last day                                                                                              |

Check what a branch would run with `node scripts/ci/changes.mjs --base origin/main`, and start a full run from the Actions tab (`workflow_dispatch`).

You can run the jobs locally with Node 24 (`.nvmrc`) and Docker running:

```sh
pnpm install --frozen-lockfile
pnpm turbo run typecheck lint           # job "typecheck, lint, test"
pnpm turbo run test --filter='!@eve/api'
pnpm --filter @eve/api test:unit
pnpm turbo run build --filter=@eve/contracts
pnpm --filter @eve/api test:int         # job "api integration tests"
pnpm --filter @eve/e2e exec playwright install chromium
pnpm turbo run e2e                      # job "e2e (Playwright)"
scripts/ci/api-image-smoke.sh           # job "api image smoke (node:22)"
pnpm agents:check && pnpm agents:test  # job "agent rules"
```

- The api integration tests start their own `postgres:17-alpine` with Testcontainers, so they need Docker but no database settings.
- The e2e global setup (`apps/e2e/support/global-setup.ts`) starts Postgres in Docker, the built api and the Vite dev server on port 5199 (set `E2E_WEB_PORT` to use another port; setup stops if anything already listens on it). When a run fails, CI uploads `apps/e2e/playwright-report/` and `apps/e2e/test-results/` as an artifact.
- The dev toolchain needs Node 24.15 or later. On Node 22, jsdom's `Blob` and Node's `Blob` differ and one web test fails. The api image still runs on Node 22 (`apps/api/Dockerfile`), so the `api image smoke` job builds that image and checks that it provisions, migrates and answers `GET /v1/health` against a throwaway Postgres.
- Concurrency: a newer push to a pull request cancels the older run. Pushes to `main` queue, so every `main` commit gets a result.
- On a loaded machine add `--concurrency=1`. Timing budgets in some tests can still fail under heavy load; rerun those files alone.

### Pre-handoff check

`pnpm check:changed` runs the checks your diff actually affects, so an agent can
reach a green tree before opening a pull request without paying for the whole repo:

```sh
pnpm check:changed                      # typecheck, lint, test in changed packages + dependents
pnpm check:changed --tasks typecheck,lint
pnpm check:changed --base main
pnpm check:changed --list               # show the diff it would use, then stop
```

- The comparison base is `origin/main` when present, else `main`, resolved through
  `git merge-base` with `HEAD`, so a stale local `main` does not inflate the diff.
  Tracked and untracked changes are both included; untracked files map to their
  owning workspace package explicitly, because turbo's git filter cannot see them.
- A change to a root manifest, the lockfile, the workspace or turbo config, or a
  shared TypeScript config runs every package. Root-level code files outside a
  package are listed as unowned; docs and other assets select no package checks.
- It stops the run after `--timeout` seconds (default 900) and exits `124`.
- It does not replace CI. It skips Playwright e2e and the api image smoke job,
  which need Docker and a built image, and it never proves the full suite passes.

## Docs

- [Backups and restore](docs/ops/backups.md): nightly encrypted backups, restore, the monthly restore drill, and off-box copies.
- [Monitoring](docs/ops/monitoring.md): the log lines to alert on, such as scheduled feed reads with failed Candidates.
- [Architecture decisions](docs/adr/): one ADR per decision.
- [Agent policy](AGENTS.md): the team's roles, cost reporting policy, and pipeline rules.

## Software factory

The AI team's controller lives in [`factory/`](factory/PROTOCOL.md). To use this
checkout as a shared factory from another project, start with
[`factory/EXTERNAL.md`](factory/EXTERNAL.md): it defines `FACTORY_ROOT`,
`PROJECT_ROOT`, and `RUN_ROOT`, version pinning, and path boundaries. To point an
agent at it, add this to the file your client loads and replace the checkout path:

```text
When I ask to use the AI team from https://github.com/Sambalicious/ai-workflow,
read /absolute/path/to/ai-team/factory/EXTERNAL.md first.
Use /absolute/path/to/ai-team as FACTORY_ROOT and this project's root as PROJECT_ROOT.
Confirm a separate private RUN_ROOT for the task using that entry.
Follow the target's rules and the scope of my actual request.
If the checkout is unavailable, stop and ask before creating one.
```

## The team's skills

Each skill's body loads on demand. The description is what the agent sees until it does.

- [`.agents/skills/animate/SKILL.md`](.agents/skills/animate/SKILL.md)
- [`.agents/skills/animation-performance/SKILL.md`](.agents/skills/animation-performance/SKILL.md)
- [`.agents/skills/animation-vocabulary/SKILL.md`](.agents/skills/animation-vocabulary/SKILL.md)
- [`.agents/skills/apple-design/SKILL.md`](.agents/skills/apple-design/SKILL.md)
- [`.agents/skills/ask-sonner/SKILL.md`](.agents/skills/ask-sonner/SKILL.md)
- [`.agents/skills/blast-radius/SKILL.md`](.agents/skills/blast-radius/SKILL.md)
- [`.agents/skills/break-ui/SKILL.md`](.agents/skills/break-ui/SKILL.md)
- [`.agents/skills/clean-code/SKILL.md`](.agents/skills/clean-code/SKILL.md)
- [`.agents/skills/clean-code-principles/SKILL.md`](.agents/skills/clean-code-principles/SKILL.md)
- [`.agents/skills/code-review/SKILL.md`](.agents/skills/code-review/SKILL.md)
- [`.agents/skills/codebase-design/SKILL.md`](.agents/skills/codebase-design/SKILL.md)
- [`.agents/skills/company-brain/SKILL.md`](.agents/skills/company-brain/SKILL.md)
- [`.agents/skills/diagnosing-bugs/SKILL.md`](.agents/skills/diagnosing-bugs/SKILL.md)
- [`.agents/skills/dispatch-worker/SKILL.md`](.agents/skills/dispatch-worker/SKILL.md)
- [`.agents/skills/domain-modeling/SKILL.md`](.agents/skills/domain-modeling/SKILL.md)
- [`.agents/skills/emil-design-eng/SKILL.md`](.agents/skills/emil-design-eng/SKILL.md)
- [`.agents/skills/factory-loop/SKILL.md`](.agents/skills/factory-loop/SKILL.md)
- [`.agents/skills/find-animation-opportunities/SKILL.md`](.agents/skills/find-animation-opportunities/SKILL.md)
- [`.agents/skills/grill-with-docs/SKILL.md`](.agents/skills/grill-with-docs/SKILL.md)
- [`.agents/skills/grilling/SKILL.md`](.agents/skills/grilling/SKILL.md)
- [`.agents/skills/hand-off/SKILL.md`](.agents/skills/hand-off/SKILL.md)
- [`.agents/skills/impeccable/SKILL.md`](.agents/skills/impeccable/SKILL.md)
- [`.agents/skills/improve-animations/SKILL.md`](.agents/skills/improve-animations/SKILL.md)
- [`.agents/skills/mobile-native/SKILL.md`](.agents/skills/mobile-native/SKILL.md)
- [`.agents/skills/nestjs-best-practices/SKILL.md`](.agents/skills/nestjs-best-practices/SKILL.md)
- [`.agents/skills/pick-ui-library/SKILL.md`](.agents/skills/pick-ui-library/SKILL.md)
- [`.agents/skills/principle-build-the-lever/SKILL.md`](.agents/skills/principle-build-the-lever/SKILL.md)
- [`.agents/skills/principle-guard-the-context-window/SKILL.md`](.agents/skills/principle-guard-the-context-window/SKILL.md)
- [`.agents/skills/principle-prove-it-works/SKILL.md`](.agents/skills/principle-prove-it-works/SKILL.md)
- [`.agents/skills/principle-separate-before-serializing-shared-state/SKILL.md`](.agents/skills/principle-separate-before-serializing-shared-state/SKILL.md)
- [`.agents/skills/principle-sequence-verifiable-units/SKILL.md`](.agents/skills/principle-sequence-verifiable-units/SKILL.md)
- [`.agents/skills/principle-type-system-discipline/SKILL.md`](.agents/skills/principle-type-system-discipline/SKILL.md)
- [`.agents/skills/prototype/SKILL.md`](.agents/skills/prototype/SKILL.md)
- [`.agents/skills/resolving-merge-conflicts/SKILL.md`](.agents/skills/resolving-merge-conflicts/SKILL.md)
- [`.agents/skills/review-animations/SKILL.md`](.agents/skills/review-animations/SKILL.md)
- [`.agents/skills/show-me-your-work/SKILL.md`](.agents/skills/show-me-your-work/SKILL.md)
- [`.agents/skills/simplify-code/SKILL.md`](.agents/skills/simplify-code/SKILL.md)
- [`.agents/skills/tdd/SKILL.md`](.agents/skills/tdd/SKILL.md)
- [`.agents/skills/technical-writing/SKILL.md`](.agents/skills/technical-writing/SKILL.md)
- [`.agents/skills/triage/SKILL.md`](.agents/skills/triage/SKILL.md)
- [`.agents/skills/typescript-best-practices/SKILL.md`](.agents/skills/typescript-best-practices/SKILL.md)
- [`.agents/skills/unslop/SKILL.md`](.agents/skills/unslop/SKILL.md)
- [`.agents/skills/wizard/SKILL.md`](.agents/skills/wizard/SKILL.md)
- [`.agents/skills/writing-for-agents/SKILL.md`](.agents/skills/writing-for-agents/SKILL.md)

The orchestrator's rules, including the [role activation policy](AGENTS.md#role-activation-policy),
live in [AGENTS.md](AGENTS.md), with the procedure in
[`.agents/reference/orchestrator.md`](.agents/reference/orchestrator.md).

## License

MIT. See [LICENSE](LICENSE). Security reports go through [SECURITY.md](SECURITY.md); contributing
rules are in [CONTRIBUTING.md](CONTRIBUTING.md).
