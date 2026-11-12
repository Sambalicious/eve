# Backups and restore

Eve keeps everything in one Postgres database and its file volumes: two flat volumes before the FEAT-0002 A2 deploy, plus the per-Candidate volume after it. This page covers the nightly encrypted backup of all of them, the on-demand backup before a deploy, checking that last night's run worked, restoring, the monthly restore drill, and getting the files off the machine.

Brief: [backups-brief.md](backups-brief.md) (B.1 to B.14). Decisions: ADR 0004 (nightly backups, kept at most 30 days) and ADR 0008 (evidence snapshots fall under the same 30-day rule).

## What a backup is

Each run writes one set of three files, or four after the FEAT-0002 A2 deploy, into `BACKUP_DIR` (default `~/eve-backups`). The names carry the UTC time of the run:

| File | Contents |
|---|---|
| `eve-db-20261023T010000Z.dump.age` | `pg_dump -Fc` of `POSTGRES_DB`, as the read-only backup role `DB_BACKUP_ROLE` (not the bootstrap superuser, not the owner). Includes the `pgboss` schema and every row of the row-level-security tables. Unlogged tables keep their definition but not their rows (`--no-unlogged-table-data`), and the row counts leave them out: the only one, `tenant_binding.candidate_binding`, binds running transactions, so a restore starts it empty. |
| `eve-candidates-20261023T010000Z.tar.age` | From FEAT-0002 A2: tar of the `job-assistant_candidate-data` volume (`<candidate_id>/{resumes,documents,exports}` and the `.storage-migrated` marker), mounted read-only. Written only when that volume exists; before the A2 deploy the run logs `step=candidates status=skipped reason=no-volume`. |
| `eve-documents-20261023T010000Z.tar.age` | Tar of the `job-assistant_document-data` volume (tailored documents), mounted read-only. |
| `eve-resumes-20261023T010000Z.tar.age` | Tar of the `job-assistant_resume-data` volume (uploaded résumés), mounted read-only. |

How it works:

- The flat document and resume archives stay in every set. Before `storage:migrate` they hold every file. After it they hold only the files that no database row names: `storage:migrate` moves every file a row names into the candidates archive's volume and leaves the others where they are, reporting them as `unreferenced left N`. That count is usually 0, so `documents_files` and `resumes_files` are usually 0 after the move; a value above 0 that matches `unreferenced left` is not an incomplete move. A restore works for sets from either side of the A2 deploy.
- The database is dumped first, then the volumes (candidates, documents, resumes). A restored set can hold orphan files, which the expiry sweep removes later. It cannot hold a row that points at a file that existed when the dump was taken but is missing from the archive.
- Each stream goes straight from `docker exec` or `docker run` into `age -r "$BACKUP_AGE_RECIPIENT"`. No plaintext touches the disk.
- Each file is written as `*.partial` and renamed only after its pipeline succeeds. An interrupted run never leaves a file that looks complete.
- The run sets `umask 077`. `BACKUP_DIR` is `0700`, and every file and `backup.log` is `0600`, owned by the user who runs it.
- The row counts are taken inside the same snapshot as the dump. The restore check then compares like with like.
- A lock folder (`BACKUP_DIR/.backup.lock`, with the run's pid in `.backup.lock/pid`) stops two runs from overlapping. It is taken with `mkdir`, which is atomic on every filesystem (including ExFAT and FAT32 USB disks), and needs no hard links. The second run exits 3 with `step=lock reason=busy`. A lock whose pid is gone, or is no longer a `backup.sh` process, is taken over; only one run at a time may do that (it holds `.backup.lock.takeover` meanwhile). A lock folder without a pid counts as busy for 10 minutes, since a run may be starting.
- After a run is killed (even with `kill -9`), the next run cleans up under the lock: the dead run's `.work.*` folder and its helper containers (labelled `eve.backup.helper=1` and with a key for this `BACKUP_DIR`). The dead run's `*.partial` files stay until the next **successful** run, whose retention step removes them. A run that fails deletes nothing. The partials hold only ciphertext.
- The helper containers run with `--log-driver none`. Their output is the plaintext tar, and any Docker log driver would copy it to the Docker host disk or ship it elsewhere.
- The run refuses to follow a symlinked `backup.log`, and it creates each `.partial` without overwriting an existing path.
- Retention runs only after a complete set is written. It deletes any backup file whose **file-name** timestamp is more than 30 days old, plus any `*.partial` left by a killed run. It goes by the name, not the mtime, because sync tools change mtimes. It never deletes the newest complete set, and it never deletes a file that does not match the backup name pattern. A failed run deletes nothing.
- The private key is never needed on the server. Only the public key (`age1…`) goes in `.env`.

## Backup role

Since migration 0017 every Candidate table and installation table has `FORCE ROW LEVEL SECURITY`. The owner role (`DB_OWNER_ROLE`) and the runtime role obey the policies, so with no Candidate scope they see no rows, and `pg_dump` as the owner fails with `query would be affected by row-level security policy for table ...`.

The backups therefore run as a separate role, `DB_BACKUP_ROLE` (for example `ja_backup`):

- It has `BYPASSRLS`, so it reads every row of every Candidate and of the installation.
- It is `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`, and is a member of no role.
- It has `CONNECT` on the database, `USAGE` on `public` and `pgboss`, and `SELECT` on every table and sequence. Default privileges give it `SELECT` on every table and sequence the owner creates later. From FEAT-0002 A2 (`0022-candidate-binding`) it also has `USAGE` on the owner-only `tenant_binding` schema and `SELECT` on its table, which `pg_dump` must lock. The runtime role has no access there.
- It has no `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `TEMPORARY` or sequence `USAGE`. It cannot change data or policies. From FEAT-0002 A2 (`0023-runtime-no-temporary`), `PUBLIC` has no `TEMPORARY` either, and every `migrate` revokes a direct `TEMPORARY` grant from the backup role.
- Its sessions start read-only (`default_transaction_read_only = on`), so it cannot write even where every role can by default, such as large objects. `pg_dump` and the row counts only read.
- No other role bypasses row-level security. The owner and runtime roles are unchanged.

Two keys in `.env` configure it:

| Key | Used by | Meaning |
|---|---|---|
| `DB_BACKUP_ROLE` | `provision-roles`, `migrate`, `backup.sh` | The role name. |
| `DB_BACKUP_PASSWORD` | `provision-roles`, `backup.sh` | Its password, at least 12 characters. Generate one with `openssl rand -hex 24`. |

`provision-roles` (the bootstrap superuser) creates the role, because only a superuser can grant `BYPASSRLS`. While `DB_BACKUP_PASSWORD` is empty the role is `NOLOGIN`, so it never has a login without a password. `migrate` (the owner) grants the read rights on every run. Both keys are optional for the stack, which starts without them, but `backup.sh` refuses to run until both are set (`reason=no-backup-role` or `reason=no-backup-password`). `backup.sh` never uses `DB_OWNER_PASSWORD`.

### One-time step for an installation deployed before the backup role

Backups have failed since the row-level-security deploy (`status=failed step=db`). After you deploy this change:

1. Add the two keys to the server's `.env`. Generate the password on the server so it never leaves it:

   ```sh
   printf 'DB_BACKUP_ROLE=ja_backup\nDB_BACKUP_PASSWORD=%s\n' "$(openssl rand -hex 24)" >>.env
   ```

2. Create the role and grant it, from the repository folder:

   ```sh
   docker compose run --rm provision-roles
   docker compose run --rm migrate
   ```

   `migrate` prints `No pending migrations` (the grants need no migration) and exits 0. `provision-roles` warns on stderr if `DB_BACKUP_ROLE` or `DB_BACKUP_PASSWORD` is still empty.
3. Take a backup and check it:

   ```sh
   scripts/backup/backup.sh --on-demand
   scripts/backup/backup-status.sh
   ```

   The backup must end with `status=ok`. Then run the restore drill below once.

`provision-roles` and `migrate` are safe to run again at any time: they converge the roles and grants. To change the password, edit `DB_BACKUP_PASSWORD` and run `provision-roles` again.

`provision-roles` refuses a `DB_BACKUP_ROLE` that names `DB_OWNER_ROLE`, `DB_RUNTIME_ROLE` or `POSTGRES_USER`, and any existing role that is a superuser, has `CREATEROLE`, `CREATEDB` or `REPLICATION`, owns objects, has role memberships, or was not created by `provision-roles` as a backup role (it marks its role with a comment). It exits 1 before it changes anything, so a typo can never give an app role `BYPASSRLS`. Pick a new, unused name.

### Renaming the backup role

Changing `DB_BACKUP_ROLE` creates a new role. The old one keeps its login, `BYPASSRLS` and its read grants until you remove it. After `provision-roles` and `migrate` have run with the new name and a backup ends with `status=ok`, drop the old role as the bootstrap superuser. Replace `ja_backup_old` with the old name:

```sh
docker compose exec postgres psql -U "$POSTGRES_USER" -d job_assistant -c 'DROP OWNED BY ja_backup_old' -c 'DROP ROLE ja_backup_old'
```

`DROP OWNED BY` removes the old role's grants and default privileges in this database (it owns nothing else). Check that no other role can bypass row-level security: `docker compose exec postgres psql -U "$POSTGRES_USER" -d job_assistant -c "select rolname from pg_roles where rolbypassrls"` should list only `POSTGRES_USER` and the new `DB_BACKUP_ROLE`.

## Install

1. Install `age` on the host (version 1.1 or newer):
   - Debian/Ubuntu: `sudo apt install age`
   - macOS: `brew install age`
   - Other: download a release from https://github.com/FiloSottile/age/releases and put `age` on the `PATH`.
2. On **your own computer, not the server**, create the key pair:

   ```sh
   age-keygen -o ~/eve-backup-identity.txt
   ```

   It prints `Public key: age1…`. Keep `~/eve-backup-identity.txt` safe and **off the server** (a password manager or an offline disk). Without it, no backup can be restored. If you lose it, every existing backup is unreadable.
3. In the server's `.env`, set the public key only. Leave `BACKUP_DIR` empty for `~/eve-backups`:

   ```sh
   BACKUP_AGE_RECIPIENT=age1...
   BACKUP_DIR=
   DB_BACKUP_ROLE=ja_backup
   DB_BACKUP_PASSWORD=
   ```

   Fill in `DB_BACKUP_PASSWORD` with a long random value, then run `provision-roles` and `migrate` (see [Backup role](#backup-role)).

   Keep comments on their own lines. The scripts read each `KEY=value` line by these rules:

   - Spaces and tabs around the value are removed.
   - An unquoted value ends at the first space or tab that is followed by `#`. That `#` and the rest of the line are dropped.
   - A `#` with no space or tab before it is part of the value (`pa#ss` stays `pa#ss`).
   - A value that is only a comment (`KEY=   # note`) is empty.
   - A value in `"double"` or `'single'` quotes is kept exactly, `#` and spaces included. Anything after the closing quote is dropped. There are no escapes and no `$VAR` expansion.
   - Only the `BACKUP_*`, `POSTGRES_DB`, `DB_OWNER_ROLE`, `DB_OWNER_PASSWORD`, `DB_BACKUP_ROLE` and `DB_BACKUP_PASSWORD` keys are read. The file is parsed, never run as shell code. `backup.sh` ignores `DB_OWNER_PASSWORD`, and restores ignore both passwords.

   `docker compose` reads the same file a little differently: it keeps a comment-only value, and a tab before `#`, as part of the value. No compose service uses the `BACKUP_*` keys, so this changes nothing for the stack.

   `.env.example` lists the optional keys (`BACKUP_RETENTION_DAYS`, `BACKUP_COMPOSE_PROJECT`, `BACKUP_DOCUMENT_VOLUME`, `BACKUP_RESUME_VOLUME`, `BACKUP_CANDIDATE_VOLUME`, `BACKUP_HELPER_IMAGE`). The defaults match `docker-compose.yml`.
4. Run one backup by hand from the repository folder, with the stack up:

   ```sh
   scripts/backup/backup.sh --on-demand
   ```

   It must end with a line containing `status=ok`. Run it as the user who will own the files, not with `sudo`. That user needs to run `docker` and `age`.

The scripts read only these keys from `.env`: `BACKUP_*`, `POSTGRES_DB`, `DB_OWNER_ROLE`, `DB_OWNER_PASSWORD`, `DB_BACKUP_ROLE` and `DB_BACKUP_PASSWORD`. They parse the file and never source it. Variables already set in the environment win over `.env`. Use `--env-file PATH` for a different file.

The script refuses to start when `BACKUP_AGE_RECIPIENT` is missing (`reason=no-recipient`) or is not a valid age public key (`reason=bad-recipient`), or when `DB_BACKUP_ROLE` or `DB_BACKUP_PASSWORD` is empty (`reason=no-backup-role`, `reason=no-backup-password`; it also names the two keys on stderr). It exits 2 before it touches Docker, and it writes nothing.

## Schedule (02:00 WAT)

The nightly run is at 02:00 WAT (Africa/Lagos, UTC+1, no daylight saving), which is 01:00 UTC. That is before the worker's 03:00 WAT expiry job. Check the host clock with `timedatectl` (Linux) or `date +%Z`. Then add **one** of these lines with `crontab -e` as the backup user. Replace `/srv/eve` with the repository path.

Host clock in **UTC**:

```cron
PATH=/usr/local/bin:/usr/bin:/bin
0 1 * * * cd /srv/eve && scripts/backup/backup.sh --nightly >/dev/null 2>&1
```

Host clock in **Africa/Lagos**:

```cron
PATH=/usr/local/bin:/usr/bin:/bin
0 2 * * * cd /srv/eve && scripts/backup/backup.sh --nightly >/dev/null 2>&1
```

Notes:

- Cron's default `PATH` often misses `docker` or `age`. Keep the `PATH=` line, and add the folder of `command -v age` if it is somewhere else.
- The output already goes to `BACKUP_DIR/backup.log`, so the lines above discard stdout. For cron mail on failure, set `MAILTO=you@example.com` above the line and end it with `>/dev/null 2>&1 || echo "eve backup failed: see backup.log"`.
- To stop backups, delete the line.
- A macOS dev machine is usually asleep at 02:00, so cron there skips the run. Use a launchd `StartCalendarInterval` job instead, or simply run the on-demand command.

## On-demand backup (before a deploy or migration)

```sh
scripts/backup/backup.sh --on-demand
```

It uses the same encryption, names, modes, log and retention as the nightly run, and logs `mode=on-demand`. The FEAT-0002 deploy steps that need this backup first are in [deploy.md](deploy.md).

After the FEAT-0002 A2 deploy, stored files live in `job-assistant_candidate-data`, and the run archives that volume too (`eve-candidates-<UTC>.tar.age`; see [deploy.md](deploy.md), "Backups after A2"). If the nightly run is busy, the command exits 3. Wait and run it again.

Exit codes: `0` ok, `1` a step failed, `2` configuration refused, `3` another run holds the lock.

## Is last night's backup OK?

Print the last result line, and check that the last `status=ok` is less than 26 hours old:

```sh
scripts/backup/backup-status.sh
```

It exits 0 when it is fresh. It exits 1 when there is no successful run in the last 26 hours, or when the newest run failed. This makes it easy to wire into any monitor. Use `--max-age-hours N` to change the window. Without the script:

```sh
grep -E 'status=(ok|failed)' ~/eve-backups/backup.log | tail -n 1   # use your BACKUP_DIR if you set one
```

The log holds only times, the run mode, step names, durations, encrypted byte sizes, file counts, the table count, the total row count, a 16-character digest of the per-table counts, and the number of files retention deleted. It never holds passwords, connection URLs, the age key, file names from inside the volumes, or any row values. A failure ends with exactly one line:

```text
... eve-backup mode=nightly status=failed step=<config|lock|db|candidates|documents|resumes|encrypt|retention> reason=<code> seconds=N
```

| `step` / `reason` | Meaning | What to do |
|---|---|---|
| `config` / `no-recipient`, `bad-recipient` | `BACKUP_AGE_RECIPIENT` is empty or not an `age1…` public key. | Fix `.env`. |
| `config` / `no-age`, `no-docker` | The tool is not on cron's `PATH`. | Fix the `PATH=` line in the crontab. |
| `config` / `no-backup-role`, `no-backup-password`, `bad-backup-role` | `DB_BACKUP_ROLE` or `DB_BACKUP_PASSWORD` is empty, or the name is not a plain lower-case identifier. | Do the [one-time step](#one-time-step-for-an-installation-deployed-before-the-backup-role). |
| `config` / `bad-backup-dir`, `bad-retention`, `no-database` | `BACKUP_DIR` is not an absolute path, `BACKUP_RETENTION_DAYS` is not 1 to 30, or `POSTGRES_DB` is empty. | Fix `.env`. |
| `config` / `cannot-create-dir`, `cannot-chmod-dir`, `log-is-symlink` | `BACKUP_DIR` cannot be created or set to mode 700, or `backup.log` is a symbolic link. | Check the folder's owner and permissions, and replace the link with a regular file. |
| `lock` / `busy` | Another backup is running. | Wait. |
| `lock` / `lock-is-symlink` | `.backup.lock` or `.backup.lock.takeover` is a symbolic link. Exit 2. | Remove the link. |
| `lock` / `set-exists` | Files for this second's set name still existed after 5 retries. | Check `BACKUP_DIR` for stray `eve-*` files with a future timestamp. |
| `db` / `no-postgres` | The `eve` stack's postgres is not running. | `docker compose up -d`. |
| `db` / `rls-hides-rows` | The role is bound by row-level security: it is not the backup role, or it has lost `BYPASSRLS`. | Check `DB_BACKUP_ROLE`, then run `provision-roles` and `migrate` again. |
| `db` / `connect`, `pg_dump`, `count` | The backup role could not connect or dump. | Check `DB_BACKUP_ROLE` and `DB_BACKUP_PASSWORD`, and that `provision-roles` and `migrate` ran with them. |
| `db` / `empty-output` | The encrypted dump is empty. | Check the free space in `BACKUP_DIR`. |
| `documents`, `resumes` / `no-volume` | The volume does not exist. | Check the volume names. The script never creates one. |
| `candidates`, `documents`, `resumes` / `tar`, `empty-output` | Reading the volume failed, or the encrypted archive is empty. A missing candidates volume is not a failure: the run logs `step=candidates status=skipped reason=no-volume` and goes on. | Check `docker` and the free space in `BACKUP_DIR`. |
| `encrypt` / `age` | `age` failed (for example, the disk is full). | Check the free space in `BACKUP_DIR`. |
| `retention` / `delete` | Deleting sets older than the retention period failed. The new set is complete. | Check the permissions in `BACKUP_DIR`. |
| any step / `unexpected` | The run stopped without a known reason (for example, it was killed). | Read the cron output, then run `scripts/backup/backup.sh --on-demand`. |

## Restore

`scripts/backup/restore.sh` decrypts a set with your identity file and restores it:

1. It runs `pg_restore --no-owner --no-acl --exit-on-error` into the postgres of a target compose project.
2. It unpacks the documents and résumés archives, and the candidates archive when the set has one (after the FEAT-0002 A2 deploy), into target volumes or into empty host folders.
3. It checks the result:
   - the table count, the total rows and the per-table count digest match the set's `status=ok` line in `backup.log`. Both sides count logged tables only, so the empty restored `tenant_binding.candidate_binding` is not compared;
   - the document and résumé file counts match that line, and so does the candidates file count (`candidates_files`) for a set with a candidates archive;
   - every `resume_upload.storage_name` and every `tailored_document` PDF and DOCX name exists in the restored folders: flat for a pre-A2 set, or at `<candidate_id>/resumes/<name>` and `<candidate_id>/documents/<name>` in the candidates target.

The target database must exist and contain no tables. Target volumes and folders must be empty. The identity file is read by `age` only. It is never copied, printed or logged. Bring it onto the machine for the restore and remove it afterwards.

By default, `restore.sh` refuses the live project (`eve`, `job-assistant`) and the live volumes (`job-assistant_*`, `eve_*`) before it contacts Docker. Restoring over live data is covered only in the disaster runbook below.

`--no-owner --no-acl` means the restored objects belong to `--target-db-user`. The drill uses the drill database's own superuser, so nothing needs to exist first. For the real disaster restore, restore as the bootstrap superuser (`POSTGRES_USER`), then run `provision-roles` and `migrate`: `provision-roles` hands every restored object in `public`, `pgboss` and, from FEAT-0002 A2, `tenant_binding` to `DB_OWNER_ROLE` (tables, partitioned tables and their partitions, sequences, views, types such as `pgboss.job_state`, routines, and the `pgboss` and `tenant_binding` schemas), and `migrate` re-applies the runtime and backup roles' grants (see the runbook). Both are safe to run again.

Why not restore as `DB_OWNER_ROLE`: the dump keeps `FORCE ROW LEVEL SECURITY` and the policies, so once they are restored the owner sees no Candidate rows, and the count and file-reference checks would run on nothing. The count check runs with `row_security=off`, so a target user bound by the policies fails with `reason=rls-hides-rows` instead of passing on missing rows.

`restore.sh` reads `BACKUP_DIR` and the configured names from `.env` (or `--env-file PATH`). Besides the default names, it refuses, in any letter case:

- any `eve*`, `job-assistant*` or `job_assistant*` project or volume;
- the configured `BACKUP_COMPOSE_PROJECT`, `BACKUP_DOCUMENT_VOLUME`, `BACKUP_RESUME_VOLUME` and `BACKUP_CANDIDATE_VOLUME`.

`restore.sh` also refuses `reason=bad-work-parent` (exit 2) when `EVE_RESTORE_WORK_PARENT` is set but is not a private directory you own: it must be a real directory (not a symlink), owned by the user running the restore, with mode `0700`. The drill sets this variable to its own private directory so it can remove the restore's temporary work directory (lists of restored file names) even if the restore is killed. You never set it yourself. If you see this refusal, run `unset EVE_RESTORE_WORK_PARENT` (or start a new shell) and run `restore.sh` again; under the drill it would mean the host's `stat` reports permissions in a form the scripts do not recognise, so run `scripts/backup/test/run-linux.sh --unit-only` (or `run-tests.sh --unit-only`) on that platform and report the failing case.

For a set with a candidates archive, `restore.sh` needs `--candidates-volume V` or `--candidates-dir D` and refuses without one (`reason=no-candidates-target`). It also refuses a set whose `backup.log` line counts candidates files when that archive is missing. Each `resume_upload` and `tailored_document` row must resolve either to its flat file (pre-A2 set) or to `<candidate_id>/resumes/<name>` or `<candidate_id>/documents/<name>` in the candidates target. A file in another Candidate's folder does not count. For an older three-file set, the step logs `step=candidates status=skipped reason=no-archive`.

The drill applies the same project rule. It also refuses a project that already has containers, volumes or networks it did not create itself (it labels its own with `eve.backup.drill=1`). The volumes and networks it checks are the three file volumes and every volume and network of the drill's compose project, by the names `docker compose config` resolves for `scripts/backup/drill.compose.yml` (`<project>_pgdata` and `<project>_drill` today), because its teardown can remove all of them. If Compose cannot report those names, the drill refuses rather than guess.

Run `scripts/backup/restore.sh --help` for every option.

## Restore drill (monthly)

Do this once a month, and after any change to the backup scripts. It restores the newest successful set into a throwaway Postgres and three throwaway volumes (documents, resumes, candidates) (compose project `ja-ops-backup-drill`, file `scripts/backup/drill.compose.yml`, no published ports, no network route out). It runs every check above, then removes the project and its volumes, whether the drill passed or failed (with `--keep` it leaves them; see steps 3 and 5). It never touches the live stack.

1. Copy your identity file to the machine that holds the backups, for example to `~/drill-identity.txt`. Run `chmod 600` on it.
2. From the repository folder, run:

   ```sh
   scripts/backup/restore-drill.sh --identity ~/drill-identity.txt
   ```

   Use `--set 20261023T010000Z` for a specific set, and `--backup-dir DIR` if `BACKUP_DIR` is not in `.env`.
3. Expected result. Every line holds counts only:

   ```text
   eve-drill step=start project=ja-ops-backup-drill set=...
   eve-restore step=db status=done tables=N rows=N counts=...
   eve-restore step=documents status=done files=N
   eve-restore step=resumes status=done files=N
   eve-restore step=candidates status=done files=N        (after A2; before it: status=skipped reason=no-archive)
   eve-restore step=references resume_refs=N resume_missing=0 document_refs=N document_missing=0
   eve-restore status=ok set=... verified=backup-log tables=N rows=N documents_files=N resumes_files=N candidates_files=N ...
   eve-drill status=ok set=... project=ja-ops-backup-drill
   ```

   Exit 0 means the backup is restorable. Exit 2 means the drill or the restore refused (`status=refused reason=...`). If the drill database does not start, the drill logs `eve-drill status=failed step=start reason=<compose-up|postgres-not-ready>` and exits 1, and no `exit=N` line follows. If the restore fails or refuses, `restore.sh` logs `eve-restore status=failed step=<db|decrypt|documents|resumes|candidates|references|verify> reason=...` (`reason=stopped` when the drill's teardown has asked it to stop before a helper container starts) (or `eve-restore status=refused reason=...`), and the drill then logs `eve-drill status=failed set=... exit=N`, where N is the restore's exit code (1 or 2). `reason=mismatch,...` names what differs.

   What the drill does with its project, and its last line, depends on where it stops. The drill removes nothing until its ownership check has finished and found that the project is its own (every existing container of the project, its three file volumes, and each volume and network that `drill.compose.yml` declares, such as `<project>_pgdata` and `<project>_drill`, carries `eve.backup.drill=1`, or none of them exists). It reads those volume and network names from `docker compose config` before the check; if that fails or lists no volume or no network, it refuses `compose-config` and removes nothing. Only then does it install the teardown that removes the project at exit.

   - **Refused before it touches Docker** (exit 2): `eve-drill status=refused reason=<unknown-argument|no-identity|bad-project|live-project|bad-db-name|no-backup-log|no-ok-set-in-log>` (`--cleanup` needs no identity and no backup log). It has created nothing, so there is nothing to remove, and that line is its last, with or without `--keep`. An option given as the last argument without its value (for example a bare `--identity`) exits 1 here with no line at all.
   - **Docker fails before `step=start`** (exit 2): if Docker is not running or not installed, or any `docker ps`, `docker inspect`, `docker volume` or `docker network` call in the ownership check fails, the drill prints `eve-drill status=refused reason=docker-unavailable` and stops. That line is its last, with or without `--keep`: no `step=start` line, no `kept` line, and it removes nothing. Start Docker and run the drill again.
   - **Compose cannot list the drill's volumes and networks** (exit 2): `eve-drill status=refused reason=compose-config` is the last line, with or without `--keep`, and nothing is removed. `docker compose -p <name> -f scripts/backup/drill.compose.yml config` failed (for example the file is missing or invalid, or the Compose plugin is not installed) or listed no volume or no network. Run that command to see the error.
   - **Refused because the project exists and the drill did not create it** (exit 2): `eve-drill status=refused reason=foreign-project` is the last line, with or without `--keep`. It leaves that project, its volumes and its network alone. The drill's own leftovers (a kept project, or one an interrupted run left behind) carry the label, so a rerun accepts and replaces them.
   - **Every exit after `step=start`** (the result lines above, or exit 1 with no result line if a Docker call fails after `step=start`): without `--keep` the drill first creates a stop flag, so `restore.sh` starts no new helper container. It then removes every container of the project together with its anonymous volumes (the compose containers and any restore helper container labelled `eve.backup.target-project=<name>`, whether running or only created). Because Docker can still create a helper for a request sent just before the stop, it repeats that removal until no such container has appeared for 2 seconds (at most 30 seconds). Then it removes the project, its volumes and its network, and its last line is the result line. It then checks that none of them is left, including the anonymous volumes of the helpers it removed. It never removes a named volume other than the drill's own, even if a labelled container mounts one, and never a live volume (a live-looking name such as `eve*` or `job-assistant*`, the built-in live volume names, or `BACKUP_DOCUMENT_VOLUME`, `BACKUP_RESUME_VOLUME` and `BACKUP_CANDIDATE_VOLUME` from `.env`, the same check `restore.sh` uses), even if it carries Docker's anonymous-volume label. If Docker cannot list the anonymous volumes, the teardown reports `unverified:anonymous-volumes` as a leftover instead of skipping them silently. Helpers mount a tmpfs over the image's `VOLUME` path, so normally they create no anonymous volume at all. If one is, it prints `eve-drill status=failed step=teardown reason=leftover left=<kind:name,...>` as the last line and exits 1 instead of 0 (other exit codes are kept); run `scripts/backup/restore-drill.sh --cleanup <name>` to try again, or remove what it names by hand (`docker rm -fv`, `docker volume rm`), because a leftover volume can hold restored, unencrypted files. With `--keep` it leaves them and adds `eve-drill kept project=<name>` after it; the exit code is the same.
   - **Stopped by a signal**: Ctrl-C, `kill <drill pid>` from another terminal, `kill -HUP` or `kill -QUIT`, or a hangup when the terminal or SSH session closes, stops the running step at once, including a restore in progress (the drill forwards the signal to `docker compose up` or `restore.sh` and their children). The drill waits until the step and every process it started have stopped, for at most 10 seconds before it kills them. That includes each helper `docker run` command of `restore.sh`, which `restore.sh` records by process ID and start time (so a reused process ID is never signalled) because it can outlive the subshell that started it. Every process is signalled only while it is still the same process (same start time). If any process has to be killed after the 10 seconds, the drill prints `eve-drill note=killed pids=<n>`. `restore.sh` keeps its temporary work directory (which holds lists of restored file names) inside the drill's private directory, so the drill removes it even when `restore.sh` was killed; if it cannot, it reports it as a leftover (`workdir:<path>`), also with `--keep`, then removes the project (or keeps it with `--keep`) and exits 128 plus the signal number: 129 (HUP), 130 (INT), 131 (QUIT) or 143 (TERM). A second signal during that shutdown is ignored, so it cannot cut the teardown short; the exit handler ignores signals as its first command. After a hangup the `kept` line may not reach a closed terminal; the project is still kept. It prints no result line, so the last line is whatever the stopped step printed before it, which can be an `eve-restore` line or a raw error from a stopped child process (for example `write /dev/stdout: broken pipe`), or `kept project=<name>` with `--keep`. A signal that arrives while a step is being started is held until the step's PID is recorded, then stops it the same way.

   Every exit of the drill, traced through `scripts/backup/restore-drill.sh` from the top:

   | Exit cause | Last line printed | Exit code | Without `--keep` | With `--keep` |
   |---|---|---|---|---|
   | `--help` | last line of the header comment | 0 | nothing created | same |
   | Unknown argument | `eve-drill status=refused reason=unknown-argument` | 2 | nothing created or removed | same |
   | Option as the last argument without its value | none | 1 | nothing created or removed | same |
   | No `--identity` | `eve-drill status=refused reason=no-identity` | 2 | nothing created or removed | same |
   | Project name not `[a-z0-9][a-z0-9_-]*` | `eve-drill status=refused reason=bad-project` | 2 | nothing created or removed | same |
   | Live-looking project name, or `BACKUP_COMPOSE_PROJECT` | `eve-drill status=refused reason=live-project` | 2 | nothing created or removed | same |
   | `--env-file` exists but cannot be read | a bash error on stderr | 1 | nothing created or removed | same |
   | Bad `POSTGRES_DB` | `eve-drill status=refused reason=bad-db-name` | 2 | nothing created or removed | same |
   | No `--set` and no `backup.log` | `eve-drill status=refused reason=no-backup-log` | 2 | nothing created or removed | same |
   | No `--set` and no `status=ok` set in `backup.log` | `eve-drill status=refused reason=no-ok-set-in-log` | 2 | nothing created or removed | same |
   | `docker compose config` of `drill.compose.yml` fails or lists no volume or no network | `eve-drill status=refused reason=compose-config` | 2 | nothing removed | same |
   | Docker call fails in the ownership check | `eve-drill status=refused reason=docker-unavailable` | 2 | nothing removed | same |
   | Project has a container, file volume, `<project>_pgdata` volume or `<project>_drill` network (any volume or network of the drill compose project, by its resolved name) without the drill label | `eve-drill status=refused reason=foreign-project` | 2 | nothing removed | same |
   | `docker compose up` fails | `eve-drill status=failed step=start reason=compose-up` | 1 | project and volumes removed | kept; last line `eve-drill kept project=<name>` |
   | Drill Postgres does not answer | `eve-drill status=failed step=start reason=postgres-not-ready` | 1 | removed | kept; last line `kept project=<name>` |
   | `docker volume create` fails | `eve-drill step=start ...` | 1 | removed | kept; last line `kept project=<name>` |
   | Restore fails or refuses | `eve-drill status=failed set=... exit=N` | N (1 or 2) | removed | kept; last line `kept project=<name>` |
   | Restore verified | `eve-drill status=ok set=... project=<name>` | 0 | removed | kept; last line `kept project=<name>` |
   | `--cleanup <name>` of a kept or left-behind drill project | `eve-drill status=ok step=cleanup project=<name>`, or `status=failed step=cleanup reason=leftover left=...` | 0, or 1 with a leftover; the refusals above (bad or live name, `compose-config`, `docker-unavailable`, `foreign-project`) also apply, with exit 2 | removes helpers, project, volumes, network | not applicable |
   | Any exit after `step=start` whose teardown leaves a container, volume (named or a helper's anonymous one), network or `restore.sh` work directory (`workdir:<path>`, also with `--keep`) behind (or cannot list them) | `eve-drill status=failed step=teardown reason=leftover left=...` | 1 if the exit code would have been 0, else unchanged | removal tried; what is named is left | not applicable (nothing is removed) |
   | Ctrl-C, `kill <drill pid>`, `kill -HUP`/`-QUIT`, or a closed terminal or SSH session, after the ownership check (stops the running step, including a restore, at once, and waits for it) | whatever the stopped step printed last, possibly a raw child error such as `write /dev/stdout: broken pipe`; no drill result line | 129 (HUP), 130 (INT), 131 (QUIT), 143 (TERM) | removed, including any restore helper container | kept; last line `kept project=<name>`, also when the signal arrives during `docker compose up` |
4. Delete the identity file again: `rm ~/drill-identity.txt`.
5. Note the date and the result. Use `--keep` if you want to look around in the drill database first. A kept project holds a full, unencrypted copy of the restored data, the database and every file, on this host until you remove it. Remove it as soon as you have finished checking, with `scripts/backup/restore-drill.sh --cleanup ja-ops-backup-drill` (or the name you passed to `--project`). It runs the drill's own ownership check and teardown: it refuses a project the drill did not create, removes any restore helper container first, then the project, its volumes and its network, and verifies that nothing is left. Its last line is `eve-drill status=ok step=cleanup project=<name>` (exit 0), or `eve-drill status=failed step=cleanup reason=leftover left=...` (exit 1) naming what is still there.

## Real disaster: restoring over the live stack

Use this only when the live data is lost or damaged. It replaces the live database and the file volumes (two before the A2 deploy, three after).

1. Check the set you are about to restore. The restore in step 6 runs as the superuser, and age does not prove who wrote a file, so restore only a set you trust:
   - Its `status=ok set=<UTC>` line is in the server's own `backup.log`, or in a copy you took from the server one way (never from a two-way synced folder that other devices write to).
   - The three file names (four for a set taken after the A2 deploy) carry that same `<UTC>` timestamp, and their sizes match the line's `db_bytes`, `documents_bytes`, `resumes_bytes` and, when present, `candidates_bytes`: `ls -l "$BACKUP_DIR"/eve-*-<UTC>.*`.
   - If you can, restore it first with the drill (`scripts/backup/restore-drill.sh --identity ... --set <UTC>`), which runs against a throwaway database.
2. Take a backup of whatever is left, if the stack still starts: `scripts/backup/backup.sh --on-demand`.
3. Stop the writers: `docker compose stop api worker`. Leave `postgres` running.
4. Recreate an empty database and the roles:

   ```sh
   docker compose exec postgres dropdb -U "$POSTGRES_USER" job_assistant
   docker compose exec postgres createdb -U "$POSTGRES_USER" job_assistant
   docker compose run --rm provision-roles
   ```

   Replace `job_assistant` with your `POSTGRES_DB`, and take `POSTGRES_USER` from `.env`.
5. Empty the file volumes. Look at the contents first, because this deletes them:

   ```sh
   docker run --rm -v job-assistant_document-data:/d -v job-assistant_resume-data:/r alpine sh -c 'rm -rf /d/* /d/.[!.]* /r/* /r/.[!.]*'
   ```

   After the A2 deploy, empty `job-assistant_candidate-data` the same way (`-v job-assistant_candidate-data:/c`, then `rm -rf /c/* /c/.[!.]*`).

6. Restore as the bootstrap superuser, with the live-data flag. Row-level security binds the owner role, so only a superuser can load and check every row:

   ```sh
   read -rs PGPASSWORD && export PGPASSWORD   # paste POSTGRES_PASSWORD; it is not echoed or kept in history
   scripts/backup/restore.sh \
     --identity ~/eve-backup-identity.txt --set 20261023T010000Z \
     --target-project eve --target-db job_assistant --target-db-user postgres_bootstrap \
     --documents-volume job-assistant_document-data --resumes-volume job-assistant_resume-data \
     --replace-live-data
   ```

   For a set taken after the A2 deploy, add `--candidates-volume job-assistant_candidate-data`. The restore refuses that set without it. It restores the `.storage-migrated` marker too, so the api and worker start.

   Use your `POSTGRES_USER` for `--target-db-user`. `PGPASSWORD` is needed only if local connections ask for a password. The script never prints it. Run `unset PGPASSWORD` afterwards. The set is looked up in `BACKUP_DIR` from `.env`; add `--backup-dir DIR` if the files are elsewhere. The flag `--replace-live-data` is the only way past the live-target refusal.
7. The archives keep the original owners and modes (`node`, `0700`/`0600`). Check this with `docker run --rm -v job-assistant_document-data:/d alpine ls -ln /d | head -3`.
8. Hand the restored objects to the owner role, re-apply the grants and start the stack:

   ```sh
   docker compose run --rm provision-roles
   docker compose run --rm migrate
   docker compose up -d
   ```

   `migrate` must print `No pending migrations` and exit 0. If it fails with `permission denied for table ...`, something in `public`, `pgboss` or `tenant_binding` is still owned by `POSTGRES_USER`: run `provision-roles` again, which hands it over, then `migrate`. Then take a backup (`scripts/backup/backup.sh --on-demand`) and check that it ends with `status=ok`.
9. Remove the identity file from the server.

## Off-box copies

Until there is a cloud upload, get copies off the machine by pointing `BACKUP_DIR` at a folder that a sync client already replicates. For example: a Syncthing folder, a Dropbox or iCloud Drive folder, or a mounted remote disk (`sshfs`, NFS, a USB disk that is rotated).

```sh
BACKUP_DIR=/home/eve/Sync/eve-backups
```

- **Every sync peer must be trusted.** age encrypts to your public key, but it does not prove who wrote a file. A peer that can write into the folder can plant a symlink, swap in a forged set (encrypted to the same public key) together with a matching `backup.log` line, or delete backups. Use a **send-only** (one-way) sync from the server: for example, Syncthing "Send Only" on the server and "Receive Only" on the other device, or a mount that only the server writes to. Do not use two-way sync.
- The files are already encrypted, so the sync provider sees only ciphertext. The file names show the backup times, but nothing else.
- Retention deletes sync too. After 30 days, the copies disappear from the other side as well. If you want a longer history somewhere, use a sync mode that keeps deleted files, and know that this keeps data past ADR 0004's 30 days.
- **Never put the age private key in the same synced folder**, or anywhere on the server. The public key in `.env` is enough to make backups.
- `backup.log` syncs as well. It holds no secrets or career data.
- The lock is a folder (`.backup.lock`) inside `BACKUP_DIR`, so it works on any filesystem a sync client or USB disk uses. Exclude `.backup.lock*` and `.work.*` from syncing if the client allows it. Two machines must never share one `BACKUP_DIR`.

## Tests

The scripts have a plain-bash test suite (TAP output). It uses only throwaway resources: compose projects `ja-ops-backup-test` and `ja-ops-backup-test-drill`, fake data, and an age key pair that it generates in a temp folder and deletes afterwards.

```sh
scripts/backup/test/run-tests.sh              # unit + integration (needs docker and age)
scripts/backup/test/run-tests.sh --unit-only  # no docker containers
scripts/backup/test/run-linux.sh [--unit-only] # the same suite in a debian:stable-slim container
```

Run it on both platforms before a change ships: macOS (BSD `stat`, `ps`) with `run-tests.sh`, and Linux (GNU coreutils and procps, the platform of the backup host) with `run-linux.sh`. `run-linux.sh` builds a small test image once, pinned so a rebuild gives the same environment: the base `debian:stable-slim` by digest and every tool by version, with `mawk` as `awk`, as on a stock Debian or Ubuntu host. It mounts the repo read-only, runs as an unprivileged user with a temp home, and uses the host Docker socket for the throwaway compose projects. The ExFAT and MS-DOS lock cases need macOS `hdiutil`; on Linux they are reported as skipped. If a pinned Debian package version is withdrawn, the build fails with a message; update the pins in `run-linux.sh` together.

**Security:** mounting the Docker socket gives the test container control of the Docker host (equivalent to root on it). Run `run-linux.sh` only on a trusted local or CI machine, from a checkout you trust. Never run it on the production backup host.

**Stopping the suite:** stop it with Ctrl-C, `kill PID` or by closing the terminal. On exit (normal, TERM, INT or HUP) it first stops every process it started, including drills that were reparented away from it (TERM, then KILL after 20 s), and only then removes its temporary directory and the volumes its unit cases created (names `ja-a2*_…` and `ja-ops-drill-f6_…` that did not exist when it started). It must stop them first: a script that outlives the directory holding its stub `docker` would reach the real Docker CLI. A `kill -9` of the suite itself skips this cleanup. It can leave a drill running and an unlabelled empty volume such as `ja-a2h-f26_documents`. In that case, stop any `restore-drill.sh` still running from a deleted `eve-backup-test.*` directory, check that `docker ps -a --filter volume=NAME` is empty, and run `docker volume rm NAME`.

It checks the following:

- refusal with a missing or malformed recipient;
- the lock, including concurrent runs and a stale lock;
- `*.partial` then rename, and cleanup after an interrupted run;
- `0600`/`0700` modes;
- retention by file name, keeping the newest complete set;
- `pg_restore --list` on the decrypted dump, with `pgboss` and the owner role;
- file counts;
- log scrubbing with marker strings for a password, profile text and file names;
- the 26-hour freshness check;
- the full restore drill, including failure when a résumé row points at a missing file, and when the counts differ.
