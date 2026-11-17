// Decides, from facts and not from the model, whether a pull request may be merged
// without a person reading it. The model can only ever block a merge: nothing it says
// can lift one of these gates.

export const MAX_CHANGED_LINES = 400
/** The diff sent to the model; a larger one is not reviewed in full, so a person must. */
export const MAX_DIFF_CHARS = 150_000
/** The commit status the review posts and the merge workflow reads. */
export const REVIEW_CONTEXT = "opus-review"

// Files whose change always needs a person: identity and sessions, the money ledger and
// cost controls, the database and tenancy (RLS), request guards and config, CI and the
// scripts that decide what CI runs, deploy, and dependency changes.
const SENSITIVE_WORDS =
  /(^|[/._-])(auth|authentication|unauthenticated|session|sessions|sign-in|signin|oidc|token|csrf|cookie|cookies|origin|guard|spend|ledger|cost|ceiling|controls|tenant|tenancy|rls|row-level-security|migration|migrations|database-roles|env)([/._-]|$)/i
const SENSITIVE_PATHS = [
  /^apps\/api\/src\/db\//,
  /^\.github\//,
  /^docker\//,
  /^scripts\/(ci|ops|backup)\//,
  /(^|\/)[^/]*compose[^/]*\.ya?ml$/,
  /(^|\/)Dockerfile[^/]*$/,
  /^pnpm-workspace\.yaml$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)package\.json$/,
  /^turbo\.json$/,
  /^\.nvmrc$/,
  /(^|\/)(vitest|playwright)[^/]*\.config\.[cm]?[jt]s$/,
  /(^|\/)eslint[^/]*\.[cm]?[jt]s$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pnpmfile\.cjs$/,
  /^patches\//,
  /^apps\/extension\/manifest\.json$/,
]

/** @param {string} path */
export function isSensitivePath(path) {
  return SENSITIVE_PATHS.some((pattern) => pattern.test(path)) || SENSITIVE_WORDS.test(path)
}

/**
 * @param {{ filename: string, previous_filename?: string }[]} files
 * @param {{ truncated: boolean, changedLines: number }} diff
 * @returns {string[]} why a person must review; empty when none of the gates applies
 */
export function humanReviewReasons(files, diff) {
  const reasons = []
  const sensitive = files.filter((file) => isSensitivePath(file.filename) || (file.previous_filename && isSensitivePath(file.previous_filename)))
  if (sensitive.length > 0) {
    const shown = sensitive.slice(0, 5).map((file) => file.filename)
    const more = sensitive.length > shown.length ? ` and ${sensitive.length - shown.length} more` : ""
    reasons.push(`touches auth, money, database, config, CI or dependency files: ${shown.join(", ")}${more}`)
  }
  if (diff.changedLines > MAX_CHANGED_LINES) reasons.push(`changes ${diff.changedLines} lines (limit ${MAX_CHANGED_LINES})`)
  if (diff.truncated) reasons.push("part of the diff could not be sent to the model, so it was not reviewed in full")
  return reasons
}

const BLOCKING = new Set(["high", "medium"])

/**
 * The model's verdict, re-derived: it only counts as clean when it says so AND lists no
 * high or medium finding. Anything malformed is not clean.
 * @param {unknown} report
 * @returns {{ clean: boolean, findings: { severity: string, file: string, summary: string, detail: string }[] }}
 */
export function readReport(report) {
  if (typeof report !== "object" || report === null) return { clean: false, findings: [] }
  const { verdict, findings } = /** @type {Record<string, unknown>} */ (report)
  if (!Array.isArray(findings) || (verdict !== "no_issues" && verdict !== "issues")) return { clean: false, findings: [] }
  const parsed = findings.map((finding) => {
    const item = typeof finding === "object" && finding !== null ? /** @type {Record<string, unknown>} */ (finding) : {}
    const severity = typeof item.severity === "string" && ["high", "medium", "low"].includes(item.severity) ? item.severity : "high"
    return {
      severity,
      file: typeof item.file === "string" ? item.file : "",
      summary: typeof item.summary === "string" ? item.summary : "unreadable finding",
      detail: typeof item.detail === "string" ? item.detail : "",
    }
  })
  const blocked = parsed.some((finding) => BLOCKING.has(finding.severity))
  return { clean: verdict === "no_issues" && !blocked, findings: parsed }
}

/**
 * Whether the commit carries a passing review. Only the latest status of the context counts.
 * @param {{ context: string, state: string }[]} statuses
 */
export function reviewPassed(statuses) {
  return statuses.find((status) => status.context === REVIEW_CONTEXT)?.state === "success"
}

/**
 * Whether every required check finished well on this commit. Skipped and neutral count, as
 * GitHub counts them for a required check. A check that has not run, or only the latest
 * rerun of which is red or still running, does not.
 * @param {string[]} required
 * @param {{ id: number, name: string, status: string, conclusion: string | null }[]} checkRuns
 */
export function requiredChecksPassed(required, checkRuns) {
  if (required.length === 0) return false
  return required.every((name) => {
    const latest = checkRuns.filter((run) => run.name === name).sort((a, b) => b.id - a.id)[0]
    return latest !== undefined && latest.status === "completed" && ["success", "skipped", "neutral"].includes(latest.conclusion ?? "")
  })
}
