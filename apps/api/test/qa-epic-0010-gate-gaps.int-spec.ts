import { ConsoleLogger, Logger } from "@nestjs/common"
import { pasteJobLinkResponseSchema } from "@eve/contracts"
import { sql } from "kysely"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { COMPANY, STRONG_EXTRACTION, TITLE, LINKS, type PasteStack, descPaystack, descriptionOfLength, holdsOf, startPasteStack } from "./support/qa-epic-0010.js"

/**
 * QA gate, step [6a], EPIC-0010 (candidate 1da2c24d). Gap tests added by the gate session for
 * approved scenarios the build-time tests left without an executable check (gherkin-responsibility.md
 * rows marked "pending"). Real route, Postgres and in-process evaluation; model calls answered by
 * FakeAnthropic. No product code is touched.
 *
 * Covers: PD:321, PD:329 (no description in logs), EV:66 (untrusted framing), EV:74
 * (POSTING_TEXT_LIMIT), EV:89 (evaluation_failed keeps the text), SAFE:111 (existing spend ledger
 * and purpose), SAFE:181 (evaluated during the global pause, as a pasted link is).
 */
let s: PasteStack

beforeAll(async () => {
  s = await startPasteStack()
})

beforeEach(async () => {
  await s.reset()
})

afterAll(async () => {
  await s?.stop()
})

const parse = (body: unknown) => pasteJobLinkResponseSchema.parse(body)
const feed = (n = 8) => {
  for (let i = 0; i < n; i += 1) s.anthropic.replyWithObject(STRONG_EXTRACTION)
}
const adaHolds = () => holdsOf(s.database.db, s.database.operatorId)

describe("PD-1.7 the description is never written to application logs", () => {
  const captured: string[] = []
  const spies: { mockRestore(): void }[] = []

  beforeEach(() => {
    captured.length = 0
    const record = (...args: unknown[]) => {
      captured.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg) ?? String(arg))).join(" "))
    }
    for (const method of ["log", "warn", "error", "debug", "verbose", "fatal"] as const) {
      spies.push(vi.spyOn(Logger.prototype, method).mockImplementation(record as never))
      spies.push(vi.spyOn(ConsoleLogger.prototype, method).mockImplementation(record as never))
      spies.push(vi.spyOn(Logger, method).mockImplementation(record as never))
    }
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream)
      spies.push(
        vi.spyOn(stream, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
          captured.push(String(chunk))
          return (original as (...a: unknown[]) => boolean)(chunk, ...rest)
        }) as never)
      )
    }
    for (const method of ["log", "info", "warn", "error", "debug"] as const) spies.push(vi.spyOn(console, method).mockImplementation(record))
  })

  afterEach(() => {
    while (spies.length > 0) spies.pop()!.mockRestore()
  })

  it("PD:321 a stored, evaluated description (and a failing evaluation) leaves no part of its text in any log line", async () => {
    const marker = "QA-GATE-PD321-SECRET"
    feed()
    const response = await s.paste(s.ada, { description: descPaystack(marker), title: TITLE, company: COMPANY })
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    // A failing evaluation logs too; its text must not carry the description either.
    s.anthropic.reset()
    s.anthropic.replyWithStatus(500)
    s.anthropic.replyWithStatus(500)
    s.anthropic.replyWithStatus(500)
    const failing = await s.paste(s.ada, { description: descPaystack(`${marker}-FAIL`), title: TITLE, company: "Failing Co" })
    expect(failing.status, JSON.stringify(failing.body)).toBe(201)
    expect(captured.length, "the paste path logs something (the spy is live)").toBeGreaterThan(0)
    const leaked = captured.filter((line) => line.includes(marker) || line.includes("Paystack helps businesses in Africa"))
    expect(leaked).toEqual([])
  })

  it("PD:329 a refused description (too long, too short, missing names) is not logged either", async () => {
    const marker = "QA-GATE-PD329-SECRET"
    const tooLong = descriptionOfLength(30_001, marker)
    const tooShort = `${marker} short text`
    const r1 = await s.paste(s.ada, { description: tooLong, title: TITLE, company: COMPANY })
    const r2 = await s.paste(s.ada, { description: tooShort, title: TITLE, company: COMPANY })
    const r3 = await s.paste(s.ada, { description: descPaystack(marker) })
    expect([r1.status, r2.status, r3.status]).toEqual([422, 422, 422])
    expect(captured.filter((line) => line.includes(marker))).toEqual([])
  })
})

describe("PD-2.2 the existing evaluation reads the pasted text", () => {
  it("EV:66 every occurrence of the description in a model request is inside <posting>…</posting>, never in a system instruction", async () => {
    const marker = "QA-GATE-EV66"
    feed()
    await s.paste(s.ada, { description: descPaystack(marker), title: TITLE, company: COMPANY })
    const requests = s.anthropic.requests.filter((request) => JSON.stringify(request.body).includes(marker))
    expect(requests.length).toBeGreaterThan(0)
    for (const request of requests) {
      const body = request.body as { system?: unknown; messages?: { content: unknown }[] }
      expect(JSON.stringify(body.system ?? ""), "system instruction").not.toContain(marker)
      // Every marker occurrence sits between an opening and a closing posting tag.
      const flat = JSON.stringify(body.messages ?? [])
      let from = 0
      for (;;) {
        const at = flat.indexOf(marker, from)
        if (at === -1) break
        const open = flat.lastIndexOf("<posting>", at)
        const close = flat.indexOf("</posting>", at)
        expect(open, "an opening <posting> before the text").toBeGreaterThan(-1)
        expect(close, "a closing </posting> after the text").toBeGreaterThan(at)
        expect(flat.lastIndexOf("</posting>", at), "no closing tag between the opening tag and the text").toBeLessThan(open)
        from = at + marker.length
      }
    }
  })

  it("EV:74 a 30,000-character description reaches the model with at most 30,000 characters of posting text", async () => {
    const marker = "QA-GATE-EV74"
    feed()
    const text = descriptionOfLength(30_000, marker)
    const response = await s.paste(s.ada, { description: text, title: TITLE, company: COMPANY })
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    const requests = s.anthropic.requests.filter((request) => JSON.stringify(request.body).includes(marker))
    expect(requests.length).toBeGreaterThan(0)
    for (const request of requests) {
      const content = JSON.stringify((request.body as { messages?: unknown }).messages ?? [])
      const match = /<posting>\\n([\s\S]*?)\\n<\/posting>/.exec(content)
      expect(match, "posting framing present").not.toBeNull()
      const posting = JSON.parse(`"${match![1]}"`) as string
      expect(posting.length).toBeLessThanOrEqual(30_000)
    }
  })

  it("EV:89 a failing evaluation leaves the pasted posting evaluation_failed with its text kept", async () => {
    for (let i = 0; i < 6; i += 1) s.anthropic.replyWithStatus(500)
    const text = descPaystack("QA-GATE-EV89")
    const response = await s.paste(s.ada, { description: text, title: TITLE, company: COMPANY })
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    const holds = await adaHolds()
    expect(holds).toHaveLength(1)
    expect(holds[0]).toMatchObject({ origin: "pasted_description", status: "evaluation_failed", posting_text: text })
  })
})

describe("PD-6.2 / PD-6.3 spend and pauses", () => {
  it("SAFE:111 the pasted evaluation is recorded in ai_call with the existing evaluation purpose and in spend_entry under an existing category", async () => {
    const before = (await s.database.db.selectFrom("spend_entry").select("id").execute()).map((row) => row.id)
    feed()
    const pasted = parse((await s.paste(s.ada, { description: descPaystack("QA-GATE-SAFE111"), title: TITLE, company: COMPANY })).body)
    const calls = await s.database.db.selectFrom("ai_call").select(["purpose", "job_posting_id", "candidate_id"]).where("job_posting_id", "=", pasted.posting.id).execute()
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call.purpose).toBe("job_posting_evaluation")
    const { rows } = await sql<{ category: string; purpose: string }>`select category, purpose from spend_entry where not (id = any(${before}::uuid[]))`.execute(s.database.db)
    expect(rows.length, "the evaluation reserved spend in the existing ledger").toBeGreaterThan(0)
    for (const row of rows) expect(["hosting", "ai", "browser", "discovery", "email"]).toContain(row.category)
  })

  it("SAFE:181 during the global pause a pasted description is evaluated, as a pasted Greenhouse link is", async () => {
    await s.database.db.updateTable("control_state").set({ global_paused: true }).execute()
    feed(16)
    const pasted = parse((await s.paste(s.ada, { description: descPaystack("QA-GATE-SAFE181"), title: TITLE, company: COMPANY })).body)
    expect(pasted.waitingReason).toBeNull()
    const holds = await adaHolds()
    const status = holds.find((hold) => hold.job_posting_id === pasted.posting.id)!.status
    expect(["ranked", "skipped", "excluded"]).toContain(status)
    // Reference: a pasted ATS link during the same pause reaches the same kind of state.
    const { atsStubs } = await import("./support/qa-epic-0010.js")
    s.google.server.use(atsStubs.greenhouseOk())
    const link = parse((await s.paste(s.ada, { url: LINKS.greenhouse })).body)
    const linkStatus = (await adaHolds()).find((hold) => hold.job_posting_id === link.posting.id)!.status
    expect(["ranked", "skipped", "excluded"]).toContain(linkStatus)
  })
})
