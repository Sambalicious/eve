import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import type { INestApplication } from "@nestjs/common"
import { CONTROLS_PATH, controlsSchema } from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { CostPausePayload } from "../../src/db/schema.js"
import { renderCostPause } from "../../src/notification/email-content.js"
import { Browser } from "../support/browser.js"
import { FakeGoogle } from "../support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "../support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "../support/signed-in.js"
import { TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp } from "../support/test-app.js"
import { TestClock } from "../support/test-clock.js"
import { CONTROLS_MONTH, seedControlsMonth } from "./controls.seed.js"

/**
 * EPIC-0002 A0 item 5 (architecture r3/r4; golden-capture.feature "Item 5"):
 * the Operator's `GET /v1/controls` body and the E4 cost-pause email render
 * for a seeded month. The render is the sender's own path: the queued
 * `cost_pause` row's payload plus the current global pause.
 *
 * A1 reruns it unchanged; slice D may differ only in the UTC month-end time.
 */
export const CONTROLS_SNAPSHOT_FILE = "controls.snap.json"
const SNAPSHOT = fileURLToPath(new URL(CONTROLS_SNAPSHOT_FILE, import.meta.url))
const CAPTURED_ON = "main db690a2 (PR #32), proved on epic-0002/slice-a0-a1"
/** A fixed dashboard origin: the render's links are part of the snapshot. */
const DASHBOARD_ORIGIN = "https://eve.example"

let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let operator: SignedInCandidate
const clock = new TestClock("2026-10-20T09:00:00.000Z")

beforeAll(async () => {
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  operator = await signInCandidate(new Browser(app, google))
  await seedControlsMonth({ app, db: database.db, clock, operator })
})

afterAll(async () => {
  await app?.close()
  google?.close()
  await database?.stop()
})

async function buildControlsSnapshot(): Promise<string> {
  const controls = controlsSchema.parse((await operator.get(CONTROLS_PATH).expect(200)).body)
  const queued = await sql<{ payload: CostPausePayload }>`select payload from notification_outbox where kind = 'cost_pause' order by created_at`.execute(database.db)
  if (queued.rows.length !== 1) throw new Error(`expected one queued cost_pause email, found ${queued.rows.length}`)
  const payload = queued.rows[0]!.payload
  const globalPaused = (await sql<{ global_paused: boolean }>`select global_paused from control_state`.execute(database.db)).rows[0]!.global_paused
  const e4 = renderCostPause({ ...payload, pausedAt: new Date(payload.pausedAt), globalPaused }, DASHBOARD_ORIGIN)
  const snapshot = {
    note: "EPIC-0002 A0 item 5: Operator controls and E4 golden. Regenerate only in its own commit with a reason.",
    capturedOn: CAPTURED_ON,
    month: CONTROLS_MONTH,
    controls,
    e4: { payload, render: e4 },
  }
  return `${JSON.stringify(snapshot, null, 2)}\n`
}

describe("controls golden (EPIC-0002 A0 item 5)", () => {
  it("is byte-equal to the committed snapshot, and stable across two runs", async () => {
    const current = await buildControlsSnapshot()
    expect(await buildControlsSnapshot()).toBe(current)
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(SNAPSHOT, current)
    expect(current).toBe(readFileSync(SNAPSHOT, "utf8"))
  })

  it("the seeded month has a raise, a cost pause and spend in every category", () => {
    const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as { controls: { costPause: unknown; spend: { raised: boolean; byCategory: Record<string, string> } } }
    expect(snapshot.controls.costPause).not.toBeNull()
    expect(snapshot.controls.spend.raised).toBe(true)
    expect(Object.values(snapshot.controls.spend.byCategory).every((value) => value !== "0.00")).toBe(true)
  })
})
