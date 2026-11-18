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

// A Dependabot version bump edits only these. They are sensitive for everyone else, but a
// bump that changes nothing else is reviewed by Opus and the required checks, not a person.
const DEPENDENCY_FILES = [/^pnpm-lock\.yaml$/, /^(apps|packages)\/[^/]+\/package\.json$/, /^package\.json$/]

/** @param {string} path */
export function isDependencyFile(path) {
  return DEPENDENCY_FILES.some((pattern) => pattern.test(path))
}

/** @param {string} path */
export function isSensitivePath(path) {
  return SENSITIVE_PATHS.some((pattern) => pattern.test(path)) || SENSITIVE_WORDS.test(path)
}

/**
 * @param {{ filename: string, previous_filename?: string }[]} files
 * @param {{ truncated: boolean, changedLines: number, dependabot?: boolean }} diff
 *   `dependabot` must be true only when the PR author and every commit are Dependabot's: the
 *   dependency manifests and the lockfile then stop being sensitive, and the line limit is
 *   waived (a lockfile diff is large), but every other gate still holds.
 * @returns {string[]} why a person must review; empty when none of the gates applies
 */
export function humanReviewReasons(files, diff) {
  const reasons = []
  const sensitiveFor = (path) => isSensitivePath(path) && !(diff.dependabot && isDependencyFile(path))
  const sensitive = files.filter((file) => sensitiveFor(file.filename) || (file.previous_filename && sensitiveFor(file.previous_filename)))
  if (sensitive.length > 0) {
    const shown = sensitive.slice(0, 5).map((file) => file.filename)
    const more = sensitive.length > shown.length ? ` and ${sensitive.length - shown.length} more` : ""
    reasons.push(`touches auth, money, database, config, CI or dependency files: ${shown.join(", ")}${more}`)
  }
  if (!diff.dependabot && diff.changedLines > MAX_CHANGED_LINES) reasons.push(`changes ${diff.changedLines} lines (limit ${MAX_CHANGED_LINES})`)
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

// ---- Automatic fixes for review findings -------------------------------------------------
// The fixer is a cheaper model that may only make small, exact text edits to files the PR
// already changes, for a finding Opus raised. Nothing here can lift a merge gate: a fix is a
// new commit, so it has no approval and is reviewed and checked like any other push.

/** A PR gets at most this many fix commits; the next push after that is a person's. */
export const MAX_FIX_ROUNDS = 2
export const MAX_FIX_EDITS = 8
export const MAX_FIX_FILES = 5
/** Lines in all the old_str and new_str values together. */
export const MAX_FIX_LINES = 60

/** Finding severities the fixer acts on. A high finding is a person's call. */
const FIXABLE = new Set(["low", "medium"])

/**
 * @param {{ severity: string, file: string }[]} findings
 * @returns {{ severity: string, file: string, summary: string, detail: string }[]}
 */
export function fixableFindings(findings) {
  if (findings.some((finding) => finding.severity === "high")) return []
  return findings.filter((finding) => FIXABLE.has(finding.severity) && finding.file !== "")
}

/**
 * @param {{ user?: { type?: string }, body?: string }[]} comments
 * @param {string} marker
 */
export function fixRoundsUsed(comments, marker) {
  return comments.filter((item) => item.user?.type === "Bot" && item.body?.startsWith(marker)).length
}

/**
 * Whether to try a fix now.
 * @param {{ findings: unknown[], rounds: number, dependabot: boolean, canPush: boolean, merged: boolean }} input
 * @returns {{ fix: boolean, why: string }}
 */
export function fixDecision({ findings, rounds, dependabot, canPush, merged }) {
  if (merged) return { fix: false, why: "the PR was merged" }
  if (!canPush) return { fix: false, why: "no push token is configured" }
  if (dependabot) return { fix: false, why: "Dependabot's PRs are not edited" }
  if (rounds >= MAX_FIX_ROUNDS) return { fix: false, why: `already fixed ${MAX_FIX_ROUNDS} times` }
  if (findings.length === 0) return { fix: false, why: "no finding the fixer may act on" }
  return { fix: true, why: "" }
}

/** @param {string} path */
function fixPathRefused(path) {
  if (path.startsWith(".github/") || path.includes("..") || path.startsWith("/")) return "CI and workflow files are never edited automatically"
  if (isDependencyFile(path) || /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(path)) return "dependency files are never edited automatically"
  return ""
}

/**
 * Checks the fixer's proposed edits and applies them to the current file texts. An edit is
 * allowed only for a file named by a fixable finding that the PR itself changes, and its
 * old_str must occur exactly once, so a vague or hallucinated edit is refused whole.
 * @param {{ file: string, old_str: string, new_str: string }[]} edits
 * @param {{ findingFiles: Set<string>, prFiles: Set<string>, contents: Map<string, string> }} context
 * @returns {{ ok: true, updated: Map<string, string> } | { ok: false, reason: string }}
 */
export function applyFixEdits(edits, { findingFiles, prFiles, contents }) {
  if (!Array.isArray(edits) || edits.length === 0) return { ok: false, reason: "no edits proposed" }
  if (edits.length > MAX_FIX_EDITS) return { ok: false, reason: `more than ${MAX_FIX_EDITS} edits` }
  const updated = new Map()
  let lines = 0
  for (const edit of edits) {
    if (typeof edit?.file !== "string" || typeof edit.old_str !== "string" || typeof edit.new_str !== "string") return { ok: false, reason: "malformed edit" }
    const refused = fixPathRefused(edit.file)
    if (refused) return { ok: false, reason: `${edit.file}: ${refused}` }
    if (!findingFiles.has(edit.file)) return { ok: false, reason: `${edit.file} is not a file a finding names` }
    if (!prFiles.has(edit.file)) return { ok: false, reason: `${edit.file} is not changed by this PR` }
    const text = updated.get(edit.file) ?? contents.get(edit.file)
    if (text === undefined) return { ok: false, reason: `${edit.file} could not be read` }
    if (edit.old_str === "" || edit.old_str === edit.new_str) return { ok: false, reason: `${edit.file}: empty or no-op edit` }
    const first = text.indexOf(edit.old_str)
    if (first === -1 || text.indexOf(edit.old_str, first + 1) !== -1) return { ok: false, reason: `${edit.file}: old_str must occur exactly once` }
    lines += edit.old_str.split("\n").length + edit.new_str.split("\n").length
    updated.set(edit.file, text.slice(0, first) + edit.new_str + text.slice(first + edit.old_str.length))
  }
  if (updated.size > MAX_FIX_FILES) return { ok: false, reason: `more than ${MAX_FIX_FILES} files` }
  if (lines > MAX_FIX_LINES) return { ok: false, reason: `edits span more than ${MAX_FIX_LINES} lines` }
  return { ok: true, updated }
}
