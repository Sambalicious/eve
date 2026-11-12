# Contributing

Small, tested, single-purpose changes. If a pull request needs a paragraph to explain why it is safe,
it needs a test instead.

## Setup

Node 24.15 or later (`.nvmrc`), pnpm 10.14, Docker running.

```sh
pnpm install
pnpm --filter @eve/contracts build
```

## Before you push

```sh
pnpm turbo run typecheck lint test build
```

Integration tests start their own Postgres with Testcontainers, so Docker must be running. The e2e
suite is separate and slower:

```sh
pnpm --filter @eve/e2e exec playwright install chromium
pnpm turbo run e2e
```

## Rules that are not negotiable

- **The claim guard.** Generated documents and outreach texts may only state what the approved Career
  Profile supports. Do not add a path that skips it, and do not weaken a check to make a test pass.
- **Row-level security.** Every Candidate table is forced RLS with the Candidate bound to the
  transaction. A new table is classified in the catalog tests in the same change.
- **Migrations are additive and named.** Never edit a migration that has shipped. Add a new one.
- **Secrets stay out.** No key, token, `.env` or credential in a commit, a test, or a snapshot. Tests
  use synthetic sentinels such as `sk-ant-test-...`.
- **Copy comes from the copy deck**, not from the pull request. If a string needs to change, say so
  and let it land in the deck.

## Pull requests

State what changed, why, and how you verified it. Include the test counts, and name anything you did
not run. Reviews are for correctness, scope and security, not for style preferences.

## Releases

This repository is generated. The maintainer works in a private tree that also holds the epics,
agent configuration and run artifacts, and publishes an allowlisted slice on each release tag.

Practically: your pull request is welcome and will be merged into the private tree, then appears in
the next release. Nothing you see here is overwritten by hand; if a file looks odd or stale, open an
issue rather than editing it in a release branch.
