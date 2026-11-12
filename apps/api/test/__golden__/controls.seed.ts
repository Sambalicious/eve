import type { INestApplication } from "@nestjs/common"
import { MONTHLY_CEILING_PATH } from "@eve/contracts"
import { type Kysely, sql } from "kysely"

import type { Database } from "../../src/db/schema.js"
import { SpendLedger } from "../../src/spend/spend-ledger.js"
import type { SignedInCandidate } from "../support/signed-in.js"
import type { TestClock } from "../support/test-clock.js"

/**
 * EPIC-0002 A0 item 5 (architecture r4 "Slice A0: golden capture", items 5
 * and 7): the seeded month behind `controls.snap.json`. October 2026 (WAT),
 * settled spend in every category, one in-flight reservation, a ceiling raise
 * to USD 60.00 through the api, then a paid action that would cross it, which
 * starts the cost pause and queues the E4 email for the Operator.
 *
 * Spend rows are raw SQL so the seed writes the same rows on `main` (no
 * `candidate_id` on `spend_entry`) and after A1. Regenerate the snapshot with
 * `UPDATE_GOLDEN=1 pnpm --filter @eve/api exec vitest run --project integration test/__golden__/controls`.
 */
export const CONTROLS_MONTH = "2026-10-01"
export const CONTROLS_SEED_TIME = "2026-10-25T10:00:00+01:00"
const USD = 1_000_000

const SETTLED: readonly Readonly<{ id: string; category: "ai" | "browser" | "discovery" | "email"; micros: number; formAgent: boolean }>[] = [
  { id: "00000000-0000-4000-8000-0000000c0001", category: "ai", micros: 12.34 * USD, formAgent: false },
  { id: "00000000-0000-4000-8000-0000000c0002", category: "browser", micros: 3.21 * USD, formAgent: false },
  { id: "00000000-0000-4000-8000-0000000c0003", category: "ai", micros: 1.05 * USD, formAgent: true },
  { id: "00000000-0000-4000-8000-0000000c0004", category: "discovery", micros: 0.55 * USD, formAgent: false },
  { id: "00000000-0000-4000-8000-0000000c0005", category: "email", micros: 0.02 * USD, formAgent: false },
]
const RESERVED = { id: "00000000-0000-4000-8000-0000000c0006", category: "ai", micros: 0.4 * USD } as const

export async function seedControlsMonth(input: Readonly<{ app: INestApplication; db: Kysely<Database>; clock: TestClock; operator: SignedInCandidate }>): Promise<void> {
  input.clock.set(CONTROLS_SEED_TIME)
  const ledger = input.app.get(SpendLedger)
  // Creates October and its hosting accrual, as the first paid action of a month does.
  await ledger.month()
  const at = input.clock.now()
  for (const row of SETTLED) {
    await sql`insert into spend_entry (id, month, category, sub_budget, purpose, status, reserved_micros, actual_micros, application_id, attempt_id, created_at, settled_at)
      values (${row.id}::uuid, ${CONTROLS_MONTH}::date, ${row.category}, ${row.formAgent ? "form_agent" : null}, 'seed', 'settled', ${row.micros}, ${row.micros}, null, null, ${at}, ${at})`.execute(input.db)
  }
  await sql`insert into spend_entry (id, month, category, sub_budget, purpose, status, reserved_micros, actual_micros, application_id, attempt_id, created_at, settled_at)
    values (${RESERVED.id}::uuid, ${CONTROLS_MONTH}::date, ${RESERVED.category}, null, 'seed', 'reserved', ${RESERVED.micros}, null, null, null, ${at}, null)`.execute(input.db)
  const raise = await input.operator.put(MONTHLY_CEILING_PATH).send({ month: CONTROLS_MONTH, ceiling: "60.00" }).expect(200)
  if ((raise.body as { result?: string }).result !== "raised") throw new Error("the controls seed expected the raise to USD 60.00 to succeed")
  input.clock.set("2026-10-25T11:30:00+01:00")
  const refused = await ledger.reserve({ category: "browser", purpose: "seed", estimateMicros: 20 * USD, action: "form filling" })
  if (refused.ok) throw new Error("the controls seed expected the USD 20.00 action to start the cost pause")
}
