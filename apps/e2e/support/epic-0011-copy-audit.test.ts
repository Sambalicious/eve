import { strict as assert } from "node:assert"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

import { E11 } from "./epic-0011-copy.ts"
import { REPO_ROOT } from "./stack.ts"

/**
 * QA test authoring, EPIC-0011 copy audit (status-words.r1.feature ST:42 "only five posting words", ST:213
 * "the copy audit lists every status string", ST:219 word counts; self-explaining-screens.feature EXP:28/62/66).
 * A static scan of apps/web/src product files (tests, stories and *.d.ts excluded). It reads the deck strings from
 * support/epic-0011-copy.ts, so a copy change is one edit there.
 * Run with `pnpm --filter @eve/e2e test`. Expected red until the web changes land.
 */
const WEB_SRC = path.join(REPO_ROOT, "apps/web/src")

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : files(full)
    return /\.(ts|tsx)$/.test(name) && !/\.(test|spec|stories|d)\.(ts|tsx)$|\.d\.ts$/.test(name) ? [full] : []
  })
}

/** Every quoted string literal and JSX text run in a file, with its file and line. */
export function stringsIn(source: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = []
  const lines = source.split("\n")
  lines.forEach((content, index) => {
    for (const match of content.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) out.push({ text: match[2]!, line: index + 1 })
    const jsx = content.match(/>([^<>{}]+)</)
    if (jsx) out.push({ text: jsx[1]!.trim(), line: index + 1 })
  })
  return out
}

/** shared/testing holds MSW handlers and fakes for unit tests; nothing there renders in the product. */
const product = () =>
  files(WEB_SRC)
    .filter((file) => !path.relative(WEB_SRC, file).startsWith(`shared${path.sep}testing${path.sep}`))
    .map((file) => ({ file, source: readFileSync(file, "utf8") }))

/**
 * QA gate (step 6a): the listed strings ST:213 allows ("listed as a reason line, detail or Advanced-only label").
 * Each entry names the file, the exact string (or a prefix) and why it is not a status word on a default screen.
 * A string that is not listed here still fails, so a new retired word on a default screen is caught.
 */
const LISTED_POSTING_LABELS: readonly { file: string; text: string; why: string }[] = [
  // A Job preferences choice for a role family's tier (EPIC-0002 B1), not a posting status. Behaviour unchanged (prd.r1 Non-goals).
  { file: "apps/web/src/features/edit-job-preferences/model/copy.ts", text: "Excluded", why: "role-family tier option in Settings" },
]
const LISTED_ADVANCED_FILES: readonly { file: string; why: string }[] = [
  // ONB:153: with Advanced on the checklist shows the same items and wording as before the upgrade.
  { file: "apps/web/src/components/setup-checklist/model/setup-items.ts", why: "Advanced-on setup checklist, unchanged by ONB:153" },
  // ADV:194, UPG:92/104: the automation pages (Check first sends, Unsure sends, samples) behave and read as before.
  { file: "apps/web/src/entities/application/model/submission-copy.ts", why: "automation pages behind Advanced and the submission detail lines of Applications that have a submission state (Operator-only today); unchanged by ADV:194 / UPG:104" },
  { file: "apps/web/src/entities/application/model/copy.ts", why: "sample (Activation Gate) refusal, shown only from the Advanced sample controls" },
  // Minimal records keep their historical final status label (Data and privacy, minimal record detail).
  { file: "apps/web/src/entities/requisition-record/model/requisition-record.ts", why: "historical final status of a minimal record (detail)" },
  // The public landing page is outside EPIC-0011 (architecture.md: public routes changed: no).
  { file: "apps/web/src/pages/landing/model/copy.ts", why: "public landing page, out of scope" },
]
const rel = (file: string) => path.relative(REPO_ROOT, file)

describe("copy audit (ST:42, ST:213)", () => {
  it("stringsIn finds quoted and JSX text with line numbers", () => {
    assert.deepEqual(stringsIn('const a = "Skipped"\n<b>Hidden</b>'), [{ text: "Skipped", line: 1 }, { text: "Hidden", line: 2 }])
  })

  it("no product file shows a retired posting status word as a whole string (Skipped, Excluded, Eligible)", () => {
    const hits: string[] = []
    for (const { file, source } of product()) {
      for (const { text, line } of stringsIn(source)) {
        const listed = LISTED_POSTING_LABELS.some((entry) => entry.file === rel(file) && entry.text === text.trim())
        if (!listed && ["Skipped", "Excluded", "Eligible"].includes(text.trim())) hits.push(`${path.relative(REPO_ROOT, file)}:${line} ${text}`)
      }
    }
    assert.deepEqual(hits, [], "retired posting status words are still shown; use Good match, Not a match, Checking, Couldn't check, Hidden")
  })

  it("the five posting words and the seven board words exist as strings in the product", () => {
    const all = new Set(product().flatMap(({ source }) => stringsIn(source).map((s) => s.text.trim())))
    for (const word of [...E11.postingWords, ...E11.columns, "Sending", E11.needsYou]) assert.ok(all.has(word), `missing status word "${word}"`)
  })

  it("the words Job Sources, Activation Gate and Uncertain Submission appear in no user-facing string", () => {
    const hits: string[] = []
    for (const { file, source } of product()) {
      if (LISTED_ADVANCED_FILES.some((entry) => entry.file === rel(file))) continue
      for (const { text, line } of stringsIn(source)) {
        if (/Job Sources|Activation Gate|Uncertain Submission/.test(text) && text.includes(" ") && !/^[a-z/#:._-]+$/i.test(text)) hits.push(`${path.relative(REPO_ROOT, file)}:${line} ${text}`)
      }
    }
    assert.deepEqual(hits, [])
  })

  it("the nav label constants carry the deck words (Check first sends, Unsure sends, Form answers, Pause and cost, Automatic applying)", () => {
    const all = product().map(({ source }) => source).join("\n")
    for (const label of [E11.navGate, E11.navUncertain, E11.navFormAnswers, E11.navPauseCost, E11.navGroup]) assert.ok(all.includes(label), `nav label "${label}" is not in apps/web/src`)
  })

  it("the Advanced switch heading and the hidden-route note are the EXACT deck strings", () => {
    const all = product().map(({ source }) => source).join("\n")
    for (const exact of [E11.advancedHeading, E11.hiddenNote, E11.hiddenTurnOn]) assert.ok(all.includes(exact), `missing EXACT string "${exact}"`)
  })
})
