# Security policy

Eve runs on your own machine and holds your real career data, your Google session and an Anthropic
key. Treat a deployment as production, because it is.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository: **Security**, then **Report a
vulnerability**. Do not open a public issue for anything that could let one installation read another
person's data, bypass the claim guard, or reuse a session.

Include what you did, what happened, and the smallest reproduction you have. A proof of concept
against a throwaway database is ideal. I aim to acknowledge within a week; this is a maintained
side project, not a company with an on-call rota.

## What is in scope

- The API in `apps/api`: authentication, sessions, row-level security, the claim and meaning checks,
  the spend ceiling, and the submission claim.
- The dashboard in `apps/web`: anything that could leak another Candidate's data or render model
  output unsafely.
- The container and backup configuration in `docker-compose.yml` and `scripts/`.

Out of scope: findings that require an already-compromised host, denial of service by resource
exhaustion on your own machine, and the behaviour of third-party job sites.

## Operating it safely

- **Keep `SUBMISSION_BROWSER_ENABLED=0`** until you have watched the app work for a while. It lets the
  worker drive a real browser against employer sites, which is the sharpest tool in the box.
- **Never expose the API without TLS.** Use Tailscale Funnel, Cloudflare Tunnel or Caddy. The session
  cookie is `__Host-` and expects HTTPS outside localhost.
- **Rotate the Anthropic key** if it was ever in a screenshot, a shared terminal, or a repository.
- **Take the backup and run the restore drill** (`docs/ops/backups.md`). An untested backup is a guess.
- **Update dependencies** with `pnpm update` and run the suite. The repo pins versions for a reason,
  but security fixes are worth the review.
- **Only one Google account** can open a dashboard, by design, set at install time.

## What the project already does

Row-level security on every Candidate table, forced at the database, with the Candidate bound to the
transaction. Generated text passes a claim check against the approved Career Profile before it is
stored or copied, and a blocked document stores only the one sentence that failed. Reader names and
stored sentences never reach the model, the logs, or another Candidate. Backups are age-encrypted
before they touch the disk.
