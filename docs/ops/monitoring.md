# Monitoring: log lines to alert on

Eve has no metrics service. The worker and api write log lines to stdout, which Docker keeps (`docker compose logs worker`). This page names the lines an operator should alert on, with a command to check each one by hand. Wire the command into any monitor you use. For backups, use `scripts/backup/backup-status.sh` ([backups.md](backups.md), "Is last night's backup OK?").

## Scheduled feed reads with failed Candidates (SEC-E8-05)

The Stack posts and Hiring feed reads run at 02:00, 08:00, 14:00 and 20:00 WAT, once for each active Candidate (FEAT-0008). If one Candidate's read fails, the worker logs it and goes on to the next Candidate. The pg-boss job still completes, so the job state does not show the failure. A failing feed (a timeout, or Google answering with an error) is not a failed read: the feed is marked failing on the Candidate's page and in her daily summary. A failed read is an error inside Eve, for example a database error.

Eve logs an internal error in two places, and an operator should alert on both:

- **A whole Candidate's read fails** (for example, her run row cannot be written). This produces the summary line below.
- **One feed's read fails with an internal error** (for example, a database error while storing that feed's posts). The reader catches it inside its feed loop, logs it, and goes on to her next feed. Her read still finishes as `completed`, so this does **not** count as a failed Candidate and does **not** produce `event=scheduled_read_candidate_failures`. See "Per-feed internal errors" below (CR-H-01).

At the end of a run that has at least one failed Candidate, the worker logs one line (after Nest's usual `[Nest] <pid> - <time>` prefix). Alert on it:

```text
ERROR [StackPostsJobs] Scheduled feed read finished with failed Candidates: event=scheduled_read_candidate_failures stack_failed=<n> hiring_failed=<n> candidates=<n>
```

- `stack_failed` and `hiring_failed` count the Candidates whose Stack posts or Hiring read failed in that run. `candidates` is the number of Candidates the run looked at.
- The line names no Candidate, feed or URL. The lines before it name each failed Candidate by id, with the error class and the file and line in Eve's code, never the message:

  ```text
  ERROR [StackPostsJobs] Stack posts read for Candidate <candidate id> failed: <ErrorClass> at <file>:<line>
  ERROR [StackPostsJobs] Hiring posts read for Candidate <candidate id> failed: <ErrorClass> at <file>:<line>
  ```

- A failure of the whole Stack posts loop (for example, the Candidate list query fails) logs `Stack posts reads failed: …` and fails the pg-boss job. Alert on that line too. The Hiring loop's equivalent is `Hiring posts reads failed: …`; it does not fail the job.

### Per-feed internal errors (CR-H-01)

An internal error while reading one feed is logged by the reader, one line per feed, and is not summarised anywhere else. Alert on it:

```text
ERROR [StackPostsReader] Alert feed <feed id> (…<last 6 digits>) read failed: internal error <ErrorClass> at <file>:<line>
ERROR [HiringPostsReader] Hiring Alert feed <feed id> (…<last 6 digits>) read failed: internal error <ErrorClass> at <file>:<line>
```

- The feed is named by its id and masked URL only, never the full URL or the error message.
- The feed's stored state is left alone (the Candidate's page does not show it as failing), and the run row counts it in `feeds_failed`.
- The same line is written when recording an ordinary feed failure (a timeout, an HTTP error) itself fails with an internal error.
- An ordinary feed failure is a `WARN` line ending in the reason (`read failed: timed_out`, `read failed: unexpected_response`, …). It is shown on the Candidate's page and is not an alert.

To check the last day by hand:

```sh
docker compose logs --since 24h worker | grep -E 'event=scheduled_read_candidate_failures|Stack posts reads failed|Hiring posts reads failed|read failed: internal error'
```

No output means no failed Candidate and no per-feed internal error in that window. A failed Candidate is read again at the next scheduled time; there is no retry in between. A failure that repeats at every run for the same Candidate id or feed id needs a look at the error class and file named in its line.
