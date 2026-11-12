# Deploying FEAT-0002 slices A1 and A2

First install, no domain: [deploy-oracle-free.md](deploy-oracle-free.md). It covers the Oracle Always Free shape, the SSH tunnel, and the backup timer.

This page lists the steps for the two FEAT-0002 deploys that move live data: A1 (the multi-candidate migration) and A2 (per-Candidate files). Run them in order. Run each deploy from the repository folder on the server, as the backup user. Backups: [backups.md](backups.md).

There is no deploy script. Each step below is one command. Do not continue after a command fails.

## Before any FEAT-0002 deploy

A1 cannot be undone without a restore. Before A1 deploys, you must have a verified Postgres backup and a file snapshot. The backup role must be set up first (see "Backup role and A2" below):

1. Stop the worker so that no job writes during the backup:

   ```sh
   docker compose stop worker
   ```

2. Take an on-demand backup with Postgres still running. It must end with `status=ok`:

   ```sh
   scripts/backup/backup.sh --on-demand
   ```

3. Verify the set with the restore drill. It must exit 0 (`backups.md`, "Restore drill"):

   ```sh
   scripts/backup/restore-drill.sh --identity ~/eve-backup-identity.txt
   ```

   Run the drill on the computer that holds the identity file. Never copy the identity file to the server.

Deploy only after both commands succeed. Record the backup set timestamp (`set=` in `backup.log`) in the deploy notes.

## A1 deploy

Follow the A1 PR description: run `migrate` once with `CANDIDATE_GOOGLE_SUB` set, then remove that key from `.env`. The api refuses to start while it is set.

## A2 deploy (per-Candidate files)

A2 moves every resume and Tailored Document from the two flat volumes (`job-assistant_resume-data`, `job-assistant_document-data`) into the per-Candidate root (`job-assistant_candidate-data`, `/data/candidates/<candidate_id>/{resumes,documents,exports}`). The api and worker refuse to start until `storage-migrate` has written its marker (`/data/candidates/.storage-migrated`). They also refuse to start while `RESUME_STORAGE_DIR` or `DOCUMENT_STORAGE_DIR` is set.

Order: backup, then `migrate`, then `storage-migrate`, then the api and worker.

1. Remove `RESUME_STORAGE_DIR` and `DOCUMENT_STORAGE_DIR` from `.env` if they are there. The compose file no longer sets them.
2. Stop the api and the worker. Leave Postgres running:

   ```sh
   docker compose stop api worker
   ```

   No process can then write a file between the backup and the move.

3. Back up the database and the file root. The command must exit 0 and end with `status=ok`:

   ```sh
   scripts/backup/backup.sh --on-demand && echo BACKUP_OK
   ```

   This archives both flat volumes, which still hold every file. If it does not print `BACKUP_OK`, stop here and restart the old stack with `docker compose start api worker`.

4. Build the new image and apply the database migrations:

   ```sh
   docker compose build && docker compose up migrate
   ```

   `migrate` must exit 0. It applies every pending migration in name order, all in one transaction (Kysely `migrateToLatest`, `apps/api/src/db/migrator.ts`), then installs the pg-boss schema and re-applies the runtime and backup roles' grants. The pending set depends on where the database is:

   - Before A1 (at 0015): `0016-multi-candidate` through `0023-runtime-no-temporary`, including FEAT-0006's `0020-role-relevance` and FEAT-0007's `0021-hiring-posts`.
   - A1 deployed, FEAT-0006 not (at 0019): `0020-role-relevance`, `0021-hiring-posts`, `0022-candidate-binding`, `0023-runtime-no-temporary`, in that order. Success prints `Applied migrations: 0020-role-relevance, 0021-hiring-posts, 0022-candidate-binding, 0023-runtime-no-temporary`.
   - FEAT-0006 deployed, FEAT-0007 not (at 0020): `0021-hiring-posts`, `0022-candidate-binding`, `0023-runtime-no-temporary`. Success prints `Applied migrations: 0021-hiring-posts, 0022-candidate-binding, 0023-runtime-no-temporary`.
   - FEAT-0007 already deployed (at 0021): `0022-candidate-binding`, `0023-runtime-no-temporary`. Success prints `Applied migrations: 0022-candidate-binding, 0023-runtime-no-temporary`.
   - From FEAT-0008 (merged after A2), every set above ends with `0024-alert-feed-candidate-verification`, and the success line names it last. If A2 is already deployed (at 0023), the set is `0024-alert-feed-candidate-verification` alone. Its rollback is in `features/active/FEAT-0008-stack-feeds-per-user/architecture.md` ("Rollback (AR-8)").

   A rerun prints `No pending migrations`.

   If one migration fails, the whole transaction rolls back: none of the pending migrations is applied, including the ones that ran before the failed one, and the database stays at the migration it had before this step (0019, 0020 or 0021 above). `migrate` exits 1 and prints `Migration <name> failed` on stderr, naming the migration that failed; earlier ones in the batch are not applied either. Check with `docker compose exec postgres psql -U "$DB_OWNER_ROLE" -d "$POSTGRES_DB" -tAc "select name from kysely_migration order by name desc limit 1"`, which still prints the previous migration. Do not start the api or worker: they refuse to boot without the new schema markers. Read the full error with `docker compose logs migrate`, fix the cause and run `docker compose up migrate` again, which retries the whole batch. Or roll back (see "Rolling back A2"); the database needs no restore in that case, because nothing was applied. A failure after the migrations, in the grant step, leaves the migrations applied; `migrate` then exits 1 without `Applied migrations`, and a rerun prints `No pending migrations` and re-applies the grants.

   `0022-candidate-binding` binds each Candidate transaction to one Candidate. It creates the owner-only schema `tenant_binding` and two security-definer functions, `bind_candidate(uuid)` and `bound_candidate()`. It also rewrites every `<table>_candidate` row policy so that a row is visible only when the transaction is bound to its Candidate. `migrate` then re-applies the grants: the runtime role may execute both functions but has no access to `tenant_binding`.

   `0023-runtime-no-temporary` revokes `TEMPORARY` on the database from `PUBLIC` and from every role except the database owner. The runtime role can then create no temporary table, which would outlive a Candidate transaction on its pooled connection. Every `migrate` revokes it again: `provision-roles` and the grant step both run the revoke, so a re-provision or a restore cannot bring it back. To check: `docker compose exec postgres psql -U "$DB_OWNER_ROLE" -d "$POSTGRES_DB" -tAc "select has_database_privilege('$DB_RUNTIME_ROLE', current_database(), 'TEMPORARY')"` prints `f`.

5. Move the files. Run this only after step 3 printed `BACKUP_OK`:

   ```sh
   docker compose --profile storage-migrate run --rm storage-migrate
   ```

   The service uses the owner role (`MIGRATION_DATABASE_URL`) and mounts all three volumes read-write. It copies each file and checks its SHA-256 against the database row. It deletes the originals only after every check has passed, then writes the marker. Success looks like `storage:migrate completed: copied N, ...`. A rerun prints `already_complete`.

   Exit 1 comes in two forms. Read stderr to tell them apart:

   - **A problem list** (`storage:migrate failed: copied N, ...` on stdout, then one `storage:migrate problem <kind>: Candidate <id> <area>/<name>` line per problem on stderr). It has deleted nothing and written no marker; the flat volumes are unchanged. Verified copies it made stay in `job-assistant_candidate-data`, and a rerun counts them as in place. The kinds:
     - `missing`: a row names a file that is not in the flat volume (a failed résumé upload without a file is not a problem; it counts as `optional missing`).
     - `sha256_mismatch`: the file, or its copy, does not match the SHA-256 the row recorded. A bad copy is removed again.
     - `not_regular_file`: the flat path is a symlink, directory or other non-regular file. It is never followed.
     - `invalid_row`: the row's storage name or Candidate ID cannot form a safe path. Nothing is copied for any row.
     - `row_count_mismatch` (Candidate `-`, name `N of M`): the rows read differ from the rows the database counted. Checked before any copy (then nothing is copied) and again after the copies (moved plus optional missing must equal the count).
   - **An exception** (`storage:migrate failed: <ErrorName>` on stderr, no problem list), for example a database or disk error. It can stop at any point, including after it started to delete originals and before it wrote the marker. Some originals may then exist only as their verified per-Candidate copies in `job-assistant_candidate-data`.

   In both cases, fix the cause and run the command again. It is idempotent: copies already in place with the right SHA-256 count as done, so a rerun after an exception finishes the move and deletes nothing it has not verified.

6. Start the api and the worker:

   ```sh
   docker compose up -d api worker
   ```

   Both must reach `healthy` (`docker compose ps`). A container that exits with "Stored files are not in the per-Candidate layout" means step 5 did not complete. A container that refuses to boot over a missing `0022-candidate-binding` or `0023-runtime-no-temporary` schema marker means step 4 did not complete. Never start an image older than this release on a database that has 0022: it binds no Candidate, so every Candidate page shows empty data. That old image fails closed and leaks nothing.

7. Check the files. Open a stored resume and a Tailored Document in the dashboard.

Steps 3 and 5 together form the guard: `&& echo BACKUP_OK` shows that the backup succeeded, and the move runs only after that. To run both in one line, chain them so that the move cannot start after a failed backup:

```sh
scripts/backup/backup.sh --on-demand && docker compose build && docker compose up migrate && docker compose --profile storage-migrate run --rm storage-migrate && docker compose up -d api worker
```

### Backups after A2

`backup.sh` archives `job-assistant_candidate-data` as a fourth encrypted file (`eve-candidates-<UTC>.tar.age`) whenever that volume exists. Before the A2 deploy the volume does not exist, so the run logs `step=candidates status=skipped reason=no-volume`. The flat volumes stay in every set: the step 3 backup holds every file there. Later sets hold only the files no database row names, which `storage-migrate` leaves in place and reports as `unreferenced left N` (usually 0). `restore.sh` and `restore-drill.sh` restore both kinds of set. See [backups.md](backups.md).

After the first nightly run following A2, check that its `backup.log` line has `candidates_files=N`, with N greater than 0 when any Candidate has files. Then run the restore drill once on that set.

### Rolling back A2

The A2 code cannot read the flat layout, and the pre-A2 code cannot read the per-Candidate layout. Roll back the image and the files together.

- **storage-migrate failed with a problem list** (exit 1, `storage:migrate problem <kind>: ...` lines, no `storage:migrate failed: <ErrorName>` line). It deleted nothing and the flat volumes are unchanged. Check out the previous release, then run `docker compose build && docker compose up -d api worker`. Keep `job-assistant_candidate-data`; the old release does not read it.
- **storage-migrate failed with an exception** (exit 1, `storage:migrate failed: <ErrorName>`). Some originals may already be deleted, and their only copies are in `job-assistant_candidate-data`. Do not start the old release on the flat volumes as they are: it would miss those files. Rerun `storage-migrate` until it prints `completed` and then roll back as "After a completed move" below, or restore the step 3 set into the flat volumes before you start the old release. Keep `job-assistant_candidate-data` either way.
- **After a completed move.** Stop the api and worker. Check out the previous release, then restore the step 3 set into the flat volumes (`backups.md`, "Real disaster: restoring over the live stack"). The step 3 set has no candidates archive, so the restore does not need a candidates target. Files that Candidates uploaded after the move exist only in `job-assistant_candidate-data`, under `<candidate_id>/resumes` and `<candidate_id>/documents`. Copy them back into the flat volumes by file name before you start the old stack. Then start the api and worker.
- Never delete `job-assistant_candidate-data` during a rollback. It is the only copy of files written after the move.

#### Rolling back the database migrations (0016 to 0023)

The migrations have no down step. `0022-candidate-binding` replaces every Candidate row policy, and the previous release does not call `bind_candidate`, so it shows no Candidate rows on a migrated database. The image and the database must move back together:

1. Stop the api and worker: `docker compose stop api worker`.
2. Check out the previous release and run `docker compose build`.
3. Restore the step 3 set over the live stack (`backups.md`, "Real disaster: restoring over the live stack"). Restore the files too if `storage-migrate` completed (see above).
4. Run `docker compose run --rm migrate`. The previous release has no 0022 or 0023, so it applies nothing and re-applies its own grants. Its `provision-roles` step, which `migrate` depends on, grants the runtime role `TEMPORARY` again, as that release expects. The restored database has no 0023 marker.
5. Start the api and worker: `docker compose up -d api worker`.

The restore loses every database write made after step 3. If the new release is healthy but has a bug, prefer a fix release over a restore.

The restore drops privileges (`--no-acl`). `migrate` re-applies them, including 0022's and 0023's: `bind_candidate` executable only by the runtime role, no runtime access to `tenant_binding`, and no `TEMPORARY` for any role except the owner. Database-level privileges such as `TEMPORARY` are not in the dump. The target database keeps the ones it had, and a newly created database gives `TEMPORARY` to `PUBLIC` until `migrate` runs. Always run `migrate` after a restore and before the api starts.

To roll back 0023 alone without a restore (for example, if a tool needs temporary tables), grant the privilege again as the owner: `grant temporary on database "$POSTGRES_DB" to "$DB_RUNTIME_ROLE"`. The next `migrate` of this release revokes it again. Doing this reopens F-SEC-14, so prefer a fix release.

### Running SQL by hand against Candidate tables (after 0022)

Every Candidate table has forced row-level security. As the owner or runtime role, a transaction sees a Candidate's rows only after two steps: it sets `eve.candidate_id` and it calls `bind_candidate` with the same ID. Without the binding the query returns 0 rows and raises no error. That is easy to misread as missing data.

```sql
begin;
select set_config('eve.candidate_id', '<candidate_id>', true);
select public.bind_candidate('<candidate_id>');
-- queries for that Candidate here
commit;
```

- Both steps last only for the transaction. Run them inside `begin` ... `commit`. Outside a transaction, every statement is its own transaction, so the binding is gone by the next statement.
- A transaction binds to one Candidate. Binding a second Candidate fails with `Refused: this transaction is bound to another Candidate`. To work on another Candidate, commit and open a new transaction.
- `bind_candidate` refuses an ID that is not in `candidate` (`Refused: not a Candidate`). Find IDs with `select id, role, email from candidate` (the `candidate` table has no row security).
- The runtime role and the owner role (which owns the function) can execute `bind_candidate`. PUBLIC cannot. Use the runtime role (`DATABASE_URL`) for reads and writes by hand, because the owner role can also change the schema.
- The bootstrap superuser (`POSTGRES_USER`) bypasses row security and sees every Candidate's rows. Use it only for read-only diagnosis, and never to write Candidate rows.

### Backup role and A2

Since `0017-row-level-security` the owner and runtime roles obey forced row security, so a dump as the owner fails. `backup.sh` therefore dumps as the read-only backup role `DB_BACKUP_ROLE` (for example `ja_backup`): `BYPASSRLS`, `SELECT` only, sessions read-only by default. `provision-roles` creates it and `migrate` grants it on every run. The role, its two `.env` keys and the one-time step for an installation deployed before it are in [backups.md](backups.md), "Backup role". Do both before the "Before any FEAT-0002 deploy" backup: `backup.sh` refuses to run without them (`reason=no-backup-role`, `reason=no-backup-password`), and a role that is bound by row security fails with `step=db reason=rls-hides-rows`.

A2 changes three things for the backup role and the restore:

- **No `TEMPORARY`.** `0023-runtime-no-temporary` revokes `TEMPORARY` from `PUBLIC`, so the backup role loses the privilege it held through `PUBLIC`. Every `migrate` also revokes a direct `TEMPORARY` grant from the backup role. `pg_dump` and `backup.sh` need no temporary table. To check: `docker compose exec postgres psql -U "$DB_OWNER_ROLE" -d "$POSTGRES_DB" -tAc "select has_database_privilege('$DB_BACKUP_ROLE', current_database(), 'TEMPORARY')"` prints `f`.
- **`tenant_binding` in the backup.** `pg_dump` locks every table it dumps, so `migrate` grants the backup role `USAGE` on the `tenant_binding` schema and `SELECT` on its table, on every run. It grants nothing else there: no `CREATE`, no writes, and the runtime role still has no access. `backup.sh` dumps the table's definition but not its rows (`pg_dump --no-unlogged-table-data`), and its row counts leave it out. The table is unlogged and each row binds one running transaction, so the rows mean nothing after a restore. A restored database has the binding table empty and working: the api binds new transactions as usual. To check after `migrate`: `docker compose exec postgres psql -U "$DB_OWNER_ROLE" -d "$POSTGRES_DB" -tAc "select has_schema_privilege('$DB_BACKUP_ROLE', 'tenant_binding', 'USAGE'), has_table_privilege('$DB_BACKUP_ROLE', 'tenant_binding.candidate_binding', 'SELECT'), has_schema_privilege('$DB_RUNTIME_ROLE', 'tenant_binding', 'USAGE')"` prints `t|t|f`.
- **`tenant_binding` after a superuser restore.** The disaster restore runs as the bootstrap superuser with `--no-owner --no-acl`, so the restored `tenant_binding` schema and its table belong to the superuser. `provision-roles` hands them to `DB_OWNER_ROLE` with the objects in `public` and `pgboss`. Without that, `migrate` fails on the binding grants. Run `provision-roles` and then `migrate` after every restore, as in [backups.md](backups.md), "Real disaster: restoring over the live stack". `migrate` must print `No pending migrations`.
