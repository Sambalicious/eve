import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import type { INestApplication } from "@nestjs/common"
import { type JobPostingsResponse, jobPostingsResponseSchema } from "@eve/contracts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { Browser } from "../support/browser.js"
import { FakeGoogle } from "../support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "../support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "../support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "../support/test-app.js"
import { TestClock } from "../support/test-clock.js"
import { goldenUuid, postingHolder, seedOwnerPostings } from "./job-postings-page.seed.js"
import { targetEveryFamily } from "../support/candidate-posting.js"

/**
 * EPIC-0002 A0 item 4 (architecture r4; golden-capture.feature "Item 4"):
 * `GET /v1/job-postings` for the single Candidate over the A0 fixtures, for
 * every tab and every filter of the fixed set. Records totalCount,
 * waitingToBeCheckedCount, the IDs, order and rank of the first two pages at
 * limit 5, and whether nextCursor is null on each page. Cursor values are
 * never recorded: their key and version change in A1.
 *
 * A1, B, E and F rerun this spec; any byte difference fails the slice. A
 * snapshot change goes in its own commit with the reason (snapshot-guard.spec.ts).
 */
export const PAGE_SNAPSHOT_FILE = "job-postings-page.snap.json"
const SNAPSHOT = fileURLToPath(new URL(PAGE_SNAPSHOT_FILE, import.meta.url))
/** The base the snapshot was captured on (golden-capture.feature, "Each snapshot header records the base commit"). */
const CAPTURED_ON = "main b17e786 (pre-A1), proved on epic-0002/slice-a0-a1"

const TABS = ["ranked", "manual", "skipped", "all"] as const
const FAMILIES = ["senior_frontend", "technical_lead", "fullstack", "product_engineering", "backend", "mobile", "devops_platform", "people_management", "other"] as const
/** The fixed filter set of A0 item 4: none; each family alone; backend,mobile; keyword react, Réact, engineer; backend with engineer. */
const FILTERS: readonly Readonly<{ families: string; keyword: string }>[] = [
  { families: "", keyword: "" },
  ...FAMILIES.map((family) => ({ families: family, keyword: "" })),
  { families: "backend,mobile", keyword: "" },
  { families: "", keyword: "react" },
  { families: "", keyword: "Réact" },
  { families: "", keyword: "engineer" },
  { families: "backend", keyword: "engineer" },
]
const LIMIT = 5

let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let candidate: SignedInCandidate
const clock = new TestClock("2026-10-21T09:00:00.000Z")

/** Stored UUID → fixture key, so the snapshot names fixtures, not generated IDs. */
const keyOf = new Map<string, string>()

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  candidate = await signInCandidate(new Browser(app, google))
  // EPIC-0006: the golden page is about order, not visibility; every family is a target.
  await targetEveryFamily(database.db, database.operatorId)
  await seedOwnerPostings(database.db, await postingHolder(database.db))
  for (let index = 1; index <= 99; index++) {
    const key = `golden-${String(index).padStart(2, "0")}`
    keyOf.set(goldenUuid(key), key)
  }
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

function query(tab: string, filter: Readonly<{ families: string; keyword: string }>, cursor: string | null): string {
  const params = new URLSearchParams({ tab, limit: String(LIMIT) })
  if (filter.families !== "") params.set("families", filter.families)
  if (filter.keyword !== "") params.set("keyword", filter.keyword)
  if (cursor !== null) params.set("cursor", cursor)
  return `/v1/job-postings?${params.toString()}`
}

async function page(path: string): Promise<JobPostingsResponse> {
  return jobPostingsResponseSchema.parse((await candidate.get(path).expect(200)).body)
}

function entryPage(response: JobPostingsResponse) {
  return {
    postings: response.postings.map((posting) => ({ id: keyOf.get(posting.id) ?? posting.id, rank: posting.rank })),
    nextCursorIsNull: response.nextCursor === null,
  }
}

async function buildPageSnapshot(): Promise<string> {
  const entries = []
  for (const filter of FILTERS) {
    for (const tab of TABS) {
      const first = await page(query(tab, filter, null))
      const second = first.nextCursor === null ? null : await page(query(tab, filter, first.nextCursor))
      entries.push({
        tab,
        families: filter.families,
        keyword: filter.keyword,
        totalCount: first.totalCount,
        waitingToBeCheckedCount: first.waitingToBeCheckedCount,
        pages: second === null ? [entryPage(first)] : [entryPage(first), entryPage(second)],
      })
    }
  }
  const snapshot = {
    note: "EPIC-0002 A0 item 4: Job Postings page golden. Regenerate only in its own commit with a reason. No cursor values are recorded.",
    capturedOn: CAPTURED_ON,
    limit: LIMIT,
    entries,
  }
  return `${JSON.stringify(snapshot, null, 2)}\n`
}

describe("Job Postings page golden (EPIC-0002 A0 item 4)", () => {
  it("is byte-equal to the committed snapshot, and stable across two runs", async () => {
    const current = await buildPageSnapshot()
    expect(await buildPageSnapshot()).toBe(current)
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(SNAPSHOT, current)
    expect(current).toBe(readFileSync(SNAPSHOT, "utf8"))
  })

  it("covers every tab for every filter of the fixed set and records no cursor value", () => {
    const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as { entries: { tab: string; families: string; keyword: string }[] }
    expect(snapshot.entries).toHaveLength(FILTERS.length * TABS.length)
    for (const filter of FILTERS) {
      for (const tab of TABS) expect(snapshot.entries.some((entry) => entry.tab === tab && entry.families === filter.families && entry.keyword === filter.keyword)).toBe(true)
    }
    expect(readFileSync(SNAPSHOT, "utf8")).not.toMatch(/"(next)?[cC]ursor"\s*:\s*"/)
  })
})
