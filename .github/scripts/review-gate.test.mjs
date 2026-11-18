import assert from "node:assert/strict"
import { test } from "node:test"

import { MAX_CHANGED_LINES, MAX_FIX_LINES, MAX_FIX_ROUNDS, applyFixEdits, fixDecision, fixRoundsUsed, fixableFindings, humanReviewReasons, isSensitivePath, readReport, requiredChecksPassed, reviewPassed } from "./review-gate.mjs"

const file = (filename) => ({ filename })
const whole = { truncated: false, changedLines: 10 }

test("auth, session, money, config, database, CI, deploy and dependency files need a person", () => {
  for (const path of [
    "apps/api/src/auth/auth.controller.ts",
    "apps/api/src/auth/session.repository.ts",
    "apps/api/test/session-expiry.int-spec.ts",
    "apps/api/test/unauthenticated.int-spec.ts",
    "apps/api/src/spend/spend-ledger.ts",
    "apps/api/src/db/scoped-checkout.ts",
    "apps/api/src/db/migrations/0042-add-thing.ts",
    "apps/api/src/tenancy/tenant-scope.ts",
    "apps/api/src/config/env.ts",
    "apps/api/src/http/json-body.guard.ts",
    "apps/extension/src/origin.ts",
    "apps/web/src/features/raise-cost-ceiling/form.tsx",
    "packages/contracts/src/controls.ts",
    ".github/workflows/ci.yml",
    "scripts/ci/changes.mjs",
    "scripts/ops/deploy.sh",
    "docker-compose.yml",
    "scripts/backup/backup-compose.yml",
    "compose.yaml",
    "apps/api/Dockerfile",
    "docker/egress/squid.conf",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "apps/web/package.json",
    "turbo.json",
    ".nvmrc",
    "apps/api/vitest.config.ts",
    "apps/e2e/playwright.config.ts",
    "apps/web/eslint.config.js",
    "apps/api/tsconfig.build.json",
    ".npmrc",
    "patches/foo.patch",
    "apps/extension/manifest.json",
  ]) {
    assert.equal(isSensitivePath(path), true, path)
  }
})

test("ordinary source, tests and docs do not", () => {
  for (const path of [
    "apps/api/src/documents/documents.service.ts",
    "apps/web/src/app/page.tsx",
    "packages/contracts/src/documents.ts",
    "docs/ops/backups.md",
    "apps/api/src/career-profile/resume-text.ts",
    "apps/web/src/authors-list.tsx",
  ]) {
    assert.equal(isSensitivePath(path), false, path)
  }
})

test("a rename out of a sensitive path still needs a person", () => {
  const reasons = humanReviewReasons([{ ...file("apps/api/src/misc/moved.ts"), previous_filename: "apps/api/src/auth/moved.ts" }], whole)
  assert.equal(reasons.length, 1)
})

test("size and truncation each need a person", () => {
  assert.deepEqual(humanReviewReasons([file("apps/web/a.ts")], { truncated: false, changedLines: MAX_CHANGED_LINES }), [])
  assert.equal(humanReviewReasons([file("apps/web/a.ts")], { truncated: false, changedLines: MAX_CHANGED_LINES + 1 }).length, 1)
  assert.equal(humanReviewReasons([file("apps/web/a.ts")], { truncated: true, changedLines: 1 }).length, 1)
})

test("only an explicit no_issues verdict with no high or medium finding is clean", () => {
  assert.equal(readReport({ verdict: "no_issues", findings: [] }).clean, true)
  assert.equal(readReport({ verdict: "no_issues", findings: [{ severity: "low", file: "a", summary: "s", detail: "d" }] }).clean, true)
  assert.equal(readReport({ verdict: "no_issues", findings: [{ severity: "medium", file: "a", summary: "s", detail: "d" }] }).clean, false)
  assert.equal(readReport({ verdict: "issues", findings: [] }).clean, false)
})

test("a malformed report is never clean", () => {
  for (const report of [null, undefined, "no_issues", {}, { verdict: "no_issues" }, { verdict: "ok", findings: [] }, { verdict: "no_issues", findings: "none" }]) {
    assert.equal(readReport(report).clean, false)
  }
  assert.equal(readReport({ verdict: "no_issues", findings: [{ severity: "weird" }] }).clean, false)
})

test("the review counts only when its latest status is success", () => {
  assert.equal(reviewPassed([{ context: "opus-review", state: "success" }]), true)
  assert.equal(reviewPassed([{ context: "opus-review", state: "pending" }]), false)
  assert.equal(reviewPassed([{ context: "opus-review", state: "failure" }]), false)
  assert.equal(reviewPassed([{ context: "other", state: "success" }]), false)
  assert.equal(reviewPassed([]), false)
})

test("every required check must be finished and green, judged by its latest run", () => {
  const run = (id, name, status, conclusion) => ({ id, name, status, conclusion })
  const required = ["a", "b"]
  assert.equal(requiredChecksPassed(required, [run(1, "a", "completed", "success"), run(2, "b", "completed", "skipped")]), true)
  assert.equal(requiredChecksPassed(required, [run(1, "a", "completed", "success")]), false)
  assert.equal(requiredChecksPassed(required, [run(1, "a", "completed", "success"), run(2, "b", "in_progress", null)]), false)
  assert.equal(requiredChecksPassed(required, [run(1, "a", "completed", "success"), run(2, "b", "completed", "failure")]), false)
  assert.equal(requiredChecksPassed(required, [run(1, "a", "completed", "success"), run(2, "b", "completed", "failure"), run(3, "b", "completed", "success")]), true)
  assert.equal(requiredChecksPassed(required, [run(1, "a", "completed", "success"), run(2, "b", "completed", "success"), run(3, "b", "completed", "failure")]), false)
  assert.equal(requiredChecksPassed([], []), false)
})

test("a Dependabot bump of manifests and the lockfile needs no person, anything else in it still does", () => {
  const bump = [file("pnpm-lock.yaml"), file("apps/api/package.json"), file("package.json")]
  const big = { truncated: false, changedLines: 5000 }
  assert.deepEqual(humanReviewReasons(bump, { ...big, dependabot: true }), [])
  assert.equal(humanReviewReasons(bump, { ...big, dependabot: false }).length, 2)
  assert.equal(humanReviewReasons([...bump, file(".github/workflows/ci.yml")], { ...big, dependabot: true }).length, 1)
  assert.equal(humanReviewReasons([file("pnpm-workspace.yaml")], { ...big, dependabot: true }).length, 1)
  assert.equal(humanReviewReasons(bump, { truncated: true, changedLines: 5000, dependabot: true }).length, 1)
})

const finding = (severity, file = "apps/api/src/a.ts") => ({ severity, file, summary: "s", detail: "d" })

test("the fixer acts on low and medium findings only, and on none when a high one exists", () => {
  assert.deepEqual(fixableFindings([finding("low"), finding("medium")]).length, 2)
  assert.deepEqual(fixableFindings([finding("low"), finding("high")]), [])
  assert.deepEqual(fixableFindings([finding("low", "")]), [])
})

test("the fix loop stops after MAX_FIX_ROUNDS commits", () => {
  const base = { findings: [finding("low")], dependabot: false, canPush: true, merged: false }
  assert.equal(fixDecision({ ...base, rounds: 0 }).fix, true)
  assert.equal(fixDecision({ ...base, rounds: MAX_FIX_ROUNDS - 1 }).fix, true)
  assert.equal(fixDecision({ ...base, rounds: MAX_FIX_ROUNDS }).fix, false)
  const bot = { user: { type: "Bot" }, body: "<!-- opus-fix -->\nRound" }
  const person = { user: { type: "User" }, body: "<!-- opus-fix -->\nforged" }
  assert.equal(fixRoundsUsed([bot, bot, person, { user: { type: "Bot" }, body: "other" }], "<!-- opus-fix -->"), 2)
})

test("no fix without a push token, for Dependabot, for a merged PR, or without findings", () => {
  const ok = { findings: [finding("low")], rounds: 0, dependabot: false, canPush: true, merged: false }
  assert.equal(fixDecision({ ...ok, canPush: false }).fix, false)
  assert.equal(fixDecision({ ...ok, dependabot: true }).fix, false)
  assert.equal(fixDecision({ ...ok, merged: true }).fix, false)
  assert.equal(fixDecision({ ...ok, findings: [] }).fix, false)
})

const context = (extra = {}) => ({
  findingFiles: new Set(["apps/api/src/a.ts"]),
  prFiles: new Set(["apps/api/src/a.ts", ".github/workflows/ci.yml", "package.json"]),
  contents: new Map([["apps/api/src/a.ts", "one\ntwo\nthree\n"]]),
  ...extra,
})
const edit = (patch = {}) => ({ file: "apps/api/src/a.ts", old_str: "two", new_str: "2", ...patch })

test("a unique exact edit to a file a finding names is applied", () => {
  const result = applyFixEdits([edit()], context())
  assert.equal(result.ok, true)
  assert.equal(result.updated.get("apps/api/src/a.ts"), "one\n2\nthree\n")
})

test("workflow, dependency, unnamed and unchanged files are never edited", () => {
  const wide = context({
    findingFiles: new Set(["apps/api/src/a.ts", ".github/workflows/ci.yml", "package.json", "apps/api/src/other.ts"]),
    contents: new Map([[".github/workflows/ci.yml", "x"], ["package.json", "x"], ["apps/api/src/other.ts", "x"], ["apps/api/src/a.ts", "x"]]),
  })
  assert.equal(applyFixEdits([edit({ file: ".github/workflows/ci.yml", old_str: "x" })], wide).ok, false)
  assert.equal(applyFixEdits([edit({ file: "package.json", old_str: "x" })], wide).ok, false)
  assert.equal(applyFixEdits([edit({ file: "apps/api/src/other.ts", old_str: "x" })], wide).ok, false)
  assert.equal(applyFixEdits([edit({ file: "apps/api/src/b.ts" })], context()).ok, false)
  assert.equal(applyFixEdits([edit({ file: "../x" })], context()).ok, false)
})

test("a missing, repeated, empty or no-op old_str refuses the whole fix", () => {
  const twice = context({ contents: new Map([["apps/api/src/a.ts", "two two"]]) })
  assert.equal(applyFixEdits([edit({ old_str: "nope" })], context()).ok, false)
  assert.equal(applyFixEdits([edit()], twice).ok, false)
  assert.equal(applyFixEdits([edit({ old_str: "" })], context()).ok, false)
  assert.equal(applyFixEdits([edit({ new_str: "two" })], context()).ok, false)
  assert.equal(applyFixEdits([edit(), edit({ old_str: "nope" })], context()).ok, false)
  assert.equal(applyFixEdits([], context()).ok, false)
  assert.equal(applyFixEdits(undefined, context()).ok, false)
})

test("a large rewrite is refused", () => {
  const big = "line\n".repeat(MAX_FIX_LINES)
  const result = applyFixEdits([edit({ old_str: "two", new_str: big })], context())
  assert.equal(result.ok, false)
})

test("the fix never changes what needs a person: sensitive paths stay sensitive", () => {
  assert.ok(humanReviewReasons([file("apps/api/src/auth/session.repository.ts")], whole).length > 0)
})
