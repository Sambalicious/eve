# Ops brief: nightly encrypted backups of the database and documents

Run: ops-db-backups. Author: Product Manager (attempt prd-1), 2026-10-22.
Scope source: `.runs/ops-backups/scope.md`, approved by the Candidate at 16:37Z and 16:48Z.
Decisions it implements: ADR 0004 (nightly off-box backups, kept at most 30 days; the Candidate owns backups and restore drills) and ADR 0008 (evidence snapshots fall under the 30-day backup rule).

## Problem statement

Eve keeps the Candidate's whole job search in one Postgres database, plus the tailored documents on the `document-data` volume. Today nothing backs either of them up. If the disk fails, a migration goes wrong, or someone runs `docker compose down -v`, the data is gone. The compose file already warns that `-v` would delete the live data. ADR 0004 promised nightly backups kept for at most 30 days, but none exist. The backups hold career data, so they must be encrypted and must not keep data past the retention window.

## Goals

- A complete, encrypted backup set exists every night. The Candidate can see whether last night's run worked without reading any data.
- The Candidate can take a backup on demand before a deploy or migration.
- A written restore drill, already rehearsed against an isolated database, proves that the backups can be restored.
- No backup is kept longer than 30 days, and no backup or log exposes secrets or career data.

## Non-goals

- Cloud upload, cloud credentials, or any provider SDK. Off-box copies come from pointing `BACKUP_DIR` at storage that is already synced (B.12).
- Key management: generating, rotating, escrowing or storing the age private key. The Candidate creates the key pair and puts only the public key in `.env`.
- Deploying or scheduling it on the live machine. The Candidate decides when to install it.
- Point-in-time recovery (WAL archiving), replicas, or backup integrity monitoring by a third-party service.
- Touching the live `eve` project or the `job-assistant_*` / `eve_*` volumes during build or tests, apart from read-only inspection.

## Acceptance criteria

Each criterion is testable. Tests use fake data in an isolated compose project.

- **B.1 Schedule.** The documented schedule runs a backup every day at 02:00 WAT (Africa/Lagos, UTC+1, no daylight saving), which is 01:00 UTC. This is before the worker's 03:00 WAT expiry job. The docs give the exact schedule line for a host clock set to UTC and for one set to Africa/Lagos.
- **B.2 Database dump.** Each run dumps the `POSTGRES_DB` database (`job_assistant`) with `pg_dump -Fc`, using the owner role (`DB_OWNER_ROLE`) and not the bootstrap superuser (SEC-001). The dump includes the `pgboss` schema. `pg_restore --list` succeeds on the decrypted file.
- **B.3 Document archive.** Each run writes a tar of the `document-data` volume, mounted read-only. It keeps the relative paths, and the number of files equals the number of regular files on the volume. The database is dumped first and the volume is archived second. A restored set can then hold orphan files (the expiry sweep removes them later), but no row can point at a missing file that existed when the dump was taken.
- **B.4 Encryption required.** Both outputs are piped straight into `age -r "$BACKUP_AGE_RECIPIENT"`. Plaintext is never written to disk, not even to a temp file. If `BACKUP_AGE_RECIPIENT` is unset, empty, or not a valid age public key (`age1…`), the run exits non-zero before it connects to the database, writes nothing, and logs `reason=no-recipient` (or `reason=bad-recipient`).
- **B.5 Location and names.** Files go to `BACKUP_DIR`, which defaults to `~/eve-backups` if unset. The directory is created with mode `0700` if it is missing. Names carry the UTC timestamp of the run, for example `eve-db-20261023T010000Z.dump.age` and `eve-documents-20261023T010000Z.tar.age`. Each file is written as `*.partial` and renamed only after its pipeline succeeds, so an interrupted run never leaves a file that looks complete.
- **B.6 Owner-only.** Each backup file is mode `0600` and the log is `0600`. All of them are owned by the user who runs the backup, and that user can read them back without sudo. The run sets `umask 077`.
- **B.7 Retention.** After a successful run, any backup file in `BACKUP_DIR` whose filename timestamp is more than 30 days old is deleted. Retention uses the name and not the mtime, because sync tools can change mtimes. Only files that match the backup name pattern are ever deleted. The newest complete set is never deleted, even if it is older than 30 days, so a month of failures cannot wipe every backup. A failed run deletes nothing.
- **B.8 On-demand backup.** One documented command runs the same backup immediately, for example before a deploy or migration, with the same encryption, naming, permissions, logging and retention as the nightly run. Two runs at the same time cannot corrupt each other: the second waits for or refuses a lock, and its exit code is non-zero if it refuses.
- **B.9 Restore script.** A restore script takes a backup timestamp (or two file paths), an age identity file path, and an explicit target. It decrypts the backup and runs `pg_restore` into the target database, then unpacks the documents into the target volume or directory. It refuses to run if the target is the live database or the `job-assistant_document-data` volume, unless the Candidate passes a separate, clearly named flag. That flag is documented only in the "real disaster" runbook section, which also says to stop `api` and `worker` first. The private key is read from the given file only and is never copied, logged, or required on the server for backups.
- **B.10 Restore drill.** `docs/ops` has a step-by-step drill. It starts an isolated Postgres (its own compose project and volumes), restores the latest set, and checks the result: `pg_restore` exits 0, the table count and row counts per table match the counts logged at backup time (B.11), and the document file count matches. The build runs this drill against fake data and records the result as evidence. The docs suggest a monthly drill, done by the Candidate.
- **B.11 Logs.** Each run appends lines to `BACKUP_DIR/backup.log` and prints them to stdout. The lines contain only: timestamp, run mode (nightly or on-demand), step, duration, byte sizes of the encrypted files, the number of document files, the number of tables, the total row count, and the number of files deleted by retention. They never contain passwords, connection URLs, the age recipient or identity, file names from inside the volume, table contents, or any value from a row. A test greps the log and the stdout of a run seeded with marker strings (fake password, fake profile text, fake document name) and finds none of them.
- **B.12 Failure visibility.** The process exits 0 only if both files were written and renamed. Any failure in any step (`set -o pipefail`) exits non-zero and logs one final line `eve-backup status=failed step=<db|documents|encrypt|retention|lock|config> reason=<short code>`. Success logs `eve-backup status=ok …` with the sizes. The docs show the Candidate one command that prints the last result line, and say how to check that the last `status=ok` is less than 26 hours old.
- **B.13 Off-box.** The docs explain how to get an off-box copy by pointing `BACKUP_DIR` at a folder that a sync client already replicates (for example a Syncthing, Dropbox or iCloud folder, or a mounted remote disk). They note that the files are already encrypted, that retention deletes also sync, and that the age private key must not sit in the same synced folder.
- **B.14 Config and docs.** `.env.example` gains `BACKUP_AGE_RECIPIENT=` (empty, with a comment on generating a key with `age-keygen` and keeping the private key off the server) and `BACKUP_DIR=` (with the default noted). A `docs/ops` section, linked from the README, covers install, schedule, on-demand, checking status, restore, the drill, and off-box.

## How it runs: decision

**Recommendation: a host script run by host cron**, for example `scripts/backup/backup.sh` and `scripts/backup/restore.sh`. The same script is the on-demand command. It reaches Postgres with `docker compose exec -T postgres pg_dump …`, which does not need a published host port. It reads the volume through a one-shot `docker run --rm -v job-assistant_document-data:/src:ro …` that writes the tar to stdout. `age` runs on the host.

| | Host cron script (recommended) | Compose service with a scheduler (for example supercronic) |
|---|---|---|
| File ownership (B.6) | Files belong to the Candidate's user naturally. `~/eve-backups` resolves. | A container writes into a bind mount as its own uid. Owner-only files may not be readable by the Candidate without uid mapping or sudo. `~` needs an absolute host path. |
| Encryption tool | `age` must be installed on the host (one package). | `age` is baked into an image, so there is one more image to pin and patch. |
| Schedule and time zone | Host cron. The time zone depends on the host clock, so B.1 documents both lines. | Explicit `TZ=Africa/Lagos` in the container, so it is independent of the host. |
| Runs when | Whenever the host is up, even if the stack is down (the script then fails loudly with `step=db`). | Only while the stack runs. `docker compose down` silently stops backups. |
| Failure visibility | Exit code, cron mail if set up, and `backup.log` next to the files. | `docker logs` plus `backup.log`. The exit code of a single job is hidden inside the scheduler. |
| Attack surface | No new long-running container. No database credentials stored in a container env. | A long-running container that holds the owner password and mounts the document volume all day. |
| Fit with "Candidate decides deployment" | Installing it means adding one crontab line, and removing it is just as easy. | It starts with `docker compose up`, so it could run by accident on a dev machine before the Candidate chooses to. |
| Portability | Needs bash, docker and age. The macOS dev machine can use launchd or cron. | The same everywhere Docker runs. |

Trade-off accepted: a host install step (`age` plus a crontab line) in exchange for correct file ownership, a visible exit code, and no always-on container holding credentials. If the Candidate later prefers a compose service, the same script can become that container's job, and only the scheduler wrapper changes.

## Assumptions

- WAT means Africa/Lagos (UTC+1 all year). The expiry job stays at 03:00 WAT. A backup of a few GB finishes in well under an hour.
- The host has bash, Docker with Compose v2, and can install `age`.
- The owner role can read every object in the database, because it owns the schema and pg-boss. Roles are not part of a database dump. Restores into an isolated database use `--no-owner --no-acl`, or run after `provision-roles`. The drill documents which one.
- Volume names stay pinned to `job-assistant_*` (docker-compose.yml). The scripts take the volume name from one variable with that default.

## Open questions

- **Q1 (blocking for DevOps, Candidate decision): include `resume-data`?** The scope and ADR 0004 name only the document volume. The `resume-data` volume (`job-assistant_resume-data`, which the api mounts at `/data/resumes`) holds uploaded résumés, and `schema.ts` rows point at those files. A restore without them leaves résumé rows with missing files. Recommendation: also tar `resume-data` into a third file with the same rules (B.3–B.7). DevOps should not add it until the Candidate says yes. Without a yes, build exactly the approved scope and document the gap in the restore drill.
- Q2 (non-blocking): Does the Candidate want a `last-ok` marker file (an empty file touched on success) in addition to the log line, for tools that check file age? The default is no; B.12 covers the need.
- Q3 (non-blocking): Should a dev machine (macOS, no cron at 02:00 while asleep) get a launchd example, or only the VPS crontab? The default is the crontab only, plus one sentence about launchd.

## Blockers

- None for this brief.
- BLOCKER[orchestrator → Candidate], before DevOps adds it: Q1, whether `resume-data` is in scope. DevOps can start on B.1–B.14 as written now.

## TL;DR for downstream agents

Build a host bash script (`scripts/backup/`), run by host cron at 02:00 WAT (01:00 UTC) and also on demand before deploys. It `pg_dump -Fc`s `job_assistant` as the owner role, then tars the `document-data` volume read-only. Each stream is piped straight into `age -r $BACKUP_AGE_RECIPIENT`. The script refuses to start without a valid recipient. Files are written as `.partial` and renamed, mode 0600, into `BACKUP_DIR` (default `~/eve-backups`, 0700). Retention deletes sets older than 30 days by filename date, never the newest set. A restore script plus a drill restore into an isolated Postgres and volume and check counts, and the script refuses live targets by default. Logs hold only counts, sizes, durations and a final `eve-backup status=ok|failed step=… reason=…` line. The exit code is non-zero on any failure. Off-box means pointing `BACKUP_DIR` at synced storage. Out of scope: cloud upload, key management, deploying it. Open: whether to include `resume-data` (Q1, needs the Candidate).

## Decision Q1 (Candidate, 2026-10-22 17:36Z)
Yes: back up the `resume-data` volume too. It becomes a third encrypted file under the same rules as the documents archive: tar of a read-only mount, piped into `age`, written `.partial` and then renamed, owner-only, kept 30 days by file name. The restore drill restores all three and checks that the résumé rows point at existing files.
