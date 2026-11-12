import type { INestApplication } from "@nestjs/common"
import { ACCESS_REQUEST_PATH, ACCESS_REQUEST_PROOF_PATH, accessRequestProofSchema } from "@eve/contracts"
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { issueProof } from "../src/access-request/fill-proof.js"
import { Browser } from "./support/browser.js"
import { FakeGoogle } from "./support/fake-google.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { type SignedInCandidate, signInCandidate } from "./support/signed-in.js"
import { PUBLIC_ORIGIN, TEST_CLIENT_ID, TEST_CLIENT_SECRET, createTestApp, testAccessRequestConfig } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * request-access.feature server scenarios against the real api app and Postgres.
 * Requests go through Fastify inject with an explicit socket address (Caddy's,
 * 10.0.0.2) and an X-Forwarded-For entry, as in production behind one proxy.
 */
const T0 = "2026-10-21T10:00:00.000Z"
const PROXY = "10.0.0.2"
const VISITOR = "198.51.100.7"
const OPERATOR = "operator@eve.example"

let database: TestDatabase
let google: FakeGoogle
let app: INestApplication
let fastify: FastifyInstance
let candidate: SignedInCandidate
const clock = new TestClock(T0)
const proofKey = testAccessRequestConfig().keys.proofKey()

beforeAll(async () => {
  process.env.NOTIFY_TO = OPERATOR
  database = await startMigratedDatabase()
  google = await FakeGoogle.create(TEST_CLIENT_ID, TEST_CLIENT_SECRET)
  google.listen()
  app = await createTestApp({ databaseUrl: database.url, clock })
  fastify = app.getHttpAdapter().getInstance() as FastifyInstance
  candidate = await signInCandidate(new Browser(app, google))
})

beforeEach(async () => {
  clock.set(T0)
  await database.db.deleteFrom("access_request").execute()
  await database.db.deleteFrom("access_request_drop").execute()
  await database.db.deleteFrom("notification_outbox").execute()
})

afterAll(async () => {
  delete process.env.NOTIFY_TO
  await app?.close()
  google?.close()
  await database?.stop()
})

/** A proof issued `ageMs` before the current test clock. */
function proofAged(ageMs = 5_000): string {
  return issueProof(clock.now().getTime() - ageMs, proofKey)
}

type SendOptions = Readonly<{ ip?: string; origin?: string | null; contentType?: string | null; headers?: Record<string, string>; remoteAddress?: string }>

function sendRaw(payload: string, options: SendOptions = {}): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.origin !== null) headers.origin = options.origin ?? PUBLIC_ORIGIN
  if (options.contentType !== null) headers["content-type"] = options.contentType ?? "application/json"
  headers["x-forwarded-for"] ??= options.ip ?? VISITOR
  const request: InjectOptions = { method: "POST", url: ACCESS_REQUEST_PATH, payload, headers, remoteAddress: options.remoteAddress ?? PROXY }
  return fastify.inject(request)
}

function send(body: Record<string, unknown>, options: SendOptions = {}): Promise<LightMyRequestResponse> {
  return sendRaw(JSON.stringify(body), options)
}

const valid = (overrides: Record<string, unknown> = {}) => ({ email: "ada@example.com", note: "", proof: proofAged(), kiwi: "", ...overrides })

async function counts() {
  const one = async (query: ReturnType<typeof sql<{ n: number }>>) => (await query.execute(database.db)).rows[0]!.n
  return {
    requests: await one(sql<{ n: number }>`select count(*)::int as n from access_request`),
    drops: await one(sql<{ n: number }>`select count(*)::int as n from access_request_drop`),
    outbox: await one(sql<{ n: number }>`select count(*)::int as n from notification_outbox where kind = 'access_request'`),
    caps: await one(sql<{ n: number }>`select count(*)::int as n from notification_outbox where kind = 'access_request_cap'`),
  }
}

const storedRequests = () => database.db.selectFrom("access_request").selectAll().orderBy("created_at").execute()

function expectReceived(response: LightMyRequestResponse): void {
  expect(response.statusCode).toBe(202)
  expect(response.body).toBe('{"status":"received"}')
}

describe("GET proof", () => {
  it("returns a proof without a session, no-store, and no cookie", async () => {
    const response = await fastify.inject({ method: "GET", url: ACCESS_REQUEST_PROOF_PATH })
    expect(response.statusCode).toBe(200)
    expect(accessRequestProofSchema.parse(response.json()).proof).toMatch(new RegExp(`^${Date.parse(T0)}\\.`))
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(response.headers["set-cookie"]).toBeUndefined()
    expect(Object.keys(response.headers).some((h) => h.startsWith("access-control-"))).toBe(false)
  })

  it("a proof from the endpoint is accepted 3 s later", async () => {
    const { proof } = (await fastify.inject({ method: "GET", url: ACCESS_REQUEST_PROOF_PATH })).json() as { proof: string }
    clock.set(new Date(Date.parse(T0) + 3_000))
    expectReceived(await send(valid({ proof })))
    expect((await counts()).requests).toBe(1)
  })
})

describe("accepted requests (AC 11.15, 11.18)", () => {
  it("stores the request and one outbox row in one step, with no cookie, no CSRF token and no session", async () => {
    const response = await send(valid({ note: "Hi, I'd like to try Eve." }))
    expectReceived(response)
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(response.headers["set-cookie"]).toBeUndefined()
    expect(response.headers["retry-after"]).toBeUndefined()
    const [row] = await storedRequests()
    expect(row).toMatchObject({ email: "ada@example.com", email_key: "ada@example.com", note: "Hi, I'd like to try Eve.", status: "waiting" })
    expect(row!.window_id).toBe(row!.id)
    expect(row!.ip_hash).toMatch(/^[0-9a-f]{64}$/)
    const outbox = await database.db.selectFrom("notification_outbox").selectAll().execute()
    expect(outbox).toHaveLength(1)
    expect(outbox[0]).toMatchObject({ kind: "access_request", status: "pending", access_request_window_id: row!.id, payload: null, application_id: null })
  })

  it("a signed-in Candidate's cookie is ignored and the request is the same", async () => {
    expectReceived(await send(valid(), { headers: { cookie: candidate.cookie } }))
    expect((await counts()).requests).toBe(1)
  })

  it.each(["  ada@example.com  ", "\tada@example.com\t", "ada@example.com\u00A0", "\u200Bada@example.com\u200B", "\uFEFFada@example.com"])("trims %j to ada@example.com", async (email) => {
    expectReceived(await send(valid({ email })))
    expect((await storedRequests())[0]!.email).toBe("ada@example.com")
  })

  it("stores a 254-character email and a 500-character note", async () => {
    const email = `${"a".repeat(64)}@${"b".repeat(60)}.${"b".repeat(60)}.${"b".repeat(55)}.example.com`
    expect(email).toHaveLength(254)
    expectReceived(await send(valid({ email, note: "x".repeat(500) })))
    const [row] = await storedRequests()
    expect(row!.email).toBe(email)
    expect(row!.note).toHaveLength(500)
  })

  it("stores an empty or whitespace-only note as empty, and strips controls but keeps line breaks", async () => {
    expectReceived(await send(valid({ email: "a1@example.com", note: "   \n\n  " })))
    expectReceived(await send(valid({ email: "a2@example.com", note: "Hi\u0007 there\u001B[31m\nThanks\u0000" })))
    const rows = await storedRequests()
    expect(rows.map((r) => r.note)).toEqual(["", "Hi there[31m\nThanks"])
  })

  it("accepts a body of exactly 4096 bytes written with JSON escapes", async () => {
    const escapes = 500
    let payload = JSON.stringify(valid({ note: "" })).replace('"note":""', `"note":"${"\\u0078".repeat(escapes)}"`)
    payload = payload.replace('"kiwi":""', `"kiwi":"${" ".repeat(4096 - Buffer.byteLength(payload))}"`)
    expect(Buffer.byteLength(payload)).toBe(4096)
    expectReceived(await sendRaw(payload))
    expect((await counts()).requests).toBe(1)
  })
})

describe("validation (AC 11.5 to 11.7)", () => {
  it.each([
    ["field missing", { note: "" }, "email.required"],
    ["empty", { email: "" }, "email.required"],
    ["blank", { email: "   " }, "email.required"],
    ["no TLD", { email: "name@gmail" }, "email.format"],
    ["display name", { email: '"Ada" <ada@example.com>' }, "email.format"],
    ["255 characters", { email: `${"a".repeat(243)}@example.com` }, "email.too_long"],
    ["CRLF Bcc", { email: "ada@example.com\r\nBcc: victim@example.net" }, "email.format"],
    ["LF Cc", { email: "ada@example.com\nCc: victim@example.net" }, "email.format"],
    ["CR Subject", { email: "ada@example.com\rSubject: Free money" }, "email.format"],
    ["U+2028", { email: "ada@example.com\u2028Bcc: victim@example.net" }, "email.format"],
    ["angle break", { email: "ada@example.com>\r\nBcc: <victim@example.net" }, "email.format"],
    ["501 emoji", { email: "ada@example.com", note: "😀".repeat(501) }, "note.too_long"],
    ["number email", { email: 12345 }, "email.format"],
    ["list note", { email: "ada@example.com", note: ["hi"] }, "note.format"],
    ["unknown field", { email: "ada@example.com", phone: "08031234567" }, "body.unknown_field"],
  ])("%s is 400 with the field code, echoes nothing and stores nothing", async (_label, body, code) => {
    const response = await send({ proof: proofAged(), ...body })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: { code: "access_request_invalid", message: "Check the highlighted fields.", fields: [code] } })
    for (const value of Object.values(body)) {
      if (typeof value === "string" && value.trim().length > 3) expect(response.body).not.toContain(value.trim().slice(0, 12))
    }
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(await counts()).toEqual({ requests: 0, drops: 0, outbox: 0, caps: 0 })
  })

  it("lists email codes before note codes", async () => {
    const response = await send(valid({ email: "name@gmail", note: "x".repeat(501) }))
    expect(response.json().error.fields).toEqual(["email.format", "note.too_long"])
  })

  it("malformed JSON is 400 body.invalid_json", async () => {
    const response = await sendRaw('{"email": "ada@example.com",')
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: { code: "access_request_invalid", message: "Check the highlighted fields.", fields: ["body.invalid_json"] } })
    expect(await counts()).toEqual({ requests: 0, drops: 0, outbox: 0, caps: 0 })
  })

  it("a JSON array or string body is 400 body.invalid_json", async () => {
    expect((await sendRaw('["ada@example.com"]')).json().error.fields).toEqual(["body.invalid_json"])
    expect((await sendRaw('"ada@example.com"')).json().error.fields).toEqual(["body.invalid_json"])
  })

  it("4097 bytes is 400 body.too_large", async () => {
    const payload = JSON.stringify(valid({ note: "" })).replace('"kiwi":""', `"kiwi":"${" ".repeat(4097 - JSON.stringify(valid({ note: "" })).length)}"`)
    expect(Buffer.byteLength(payload)).toBe(4097)
    const response = await sendRaw(payload)
    expect(response.statusCode).toBe(400)
    expect(response.json().error.fields).toEqual(["body.too_large"])
    expect(await counts()).toEqual({ requests: 0, drops: 0, outbox: 0, caps: 0 })
  })

  it("400s do not count toward the per-IP limit", async () => {
    for (let i = 0; i < 5; i++) expect((await send(valid({ email: "bad" }))).statusCode).toBe(400)
    expectReceived(await send(valid()))
  })

  it("other JSON routes keep bad_request for malformed JSON", async () => {
    const response = await candidate.post("/v1/controls/global-pause").set("content-type", "application/json").send('{"paused":')
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe("bad_request")
  })
})

describe("Origin and media type (AC 11.13, 11.14)", () => {
  it.each([
    ["missing", null],
    ["null", "null"],
    ["other site", "https://evil.example"],
    ["http", "http://dashboard.test"],
    ["port", "https://dashboard.test:8443"],
    ["suffix", "https://dashboard.test.evil.example"],
  ])("Origin %s is 403 origin_forbidden, stores and counts nothing", async (_label, origin) => {
    const response = await send(valid(), { origin })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: { code: "origin_forbidden", message: "This request must come from the Eve page." } })
    expect(await counts()).toEqual({ requests: 0, drops: 0, outbox: 0, caps: 0 })
  })

  it.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"])("Content-Type %s is 415", async (contentType) => {
    const response = await sendRaw("email=ada%40example.com", { contentType })
    expect(response.statusCode).toBe(415)
    expect(response.json().error.code).toBe("unsupported_media_type")
    expect(await counts()).toEqual({ requests: 0, drops: 0, outbox: 0, caps: 0 })
  })

  it("refused Origins and media types don't count toward the per-IP limit", async () => {
    for (let i = 0; i < 4; i++) await send(valid(), { origin: "https://evil.example" })
    for (let i = 0; i < 4; i++) await sendRaw("x", { contentType: "text/plain" })
    expectReceived(await send(valid()))
  })

  it("a cross-site preflight gets no CORS headers", async () => {
    const response = await fastify.inject({
      method: "OPTIONS",
      url: ACCESS_REQUEST_PATH,
      headers: { origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    })
    expect(response.statusCode).toBe(404)
    expect(Object.keys(response.headers).some((h) => h.startsWith("access-control-"))).toBe(false)
  })

  it("the endpoint needs no CSRF token, while another state-changing route still does", async () => {
    expectReceived(await send(valid()))
    const response = await candidate.get("/v1/session")
    expect(response.status).toBe(200)
    const noToken = await new Browser(app, google).http().put("/v1/controls/global-pause").set("cookie", candidate.cookie).send({ paused: true })
    expect(noToken.status).toBe(403)
    expect(noToken.body.error.code).toBe("csrf_invalid")
  })
})

describe("silent drops (AC 11.10 to 11.12)", () => {
  it("a filled honeypot gets the same 202 and stores only a drop row", async () => {
    expectReceived(await send(valid({ kiwi: "https://spam.example" })))
    expect(await counts()).toEqual({ requests: 0, drops: 1, outbox: 0, caps: 0 })
    const [drop] = await database.db.selectFrom("access_request_drop").selectAll().execute()
    expect(drop).toMatchObject({ reason: "honeypot" })
  })

  it.each([
    ["missing", undefined],
    ["garbage", "not-a-proof"],
    ["2.9 s old", "AGE:2900"],
    ["future", "AGE:-10000"],
    ["expired", `AGE:${24 * 3_600_000 + 1}`],
    ["forged", `${Date.parse(T0) - 60_000}.AAAAAAAAAAAAAAAAAAAAAA`],
  ])("a %s proof gets the same 202 and a fill_time drop", async (_label, proof) => {
    const value = typeof proof === "string" && proof.startsWith("AGE:") ? proofAged(Number(proof.slice(4))) : proof
    const body = valid()
    if (value === undefined) delete (body as Record<string, unknown>).proof
    else body.proof = value
    expectReceived(await send(body))
    expect(await counts()).toEqual({ requests: 0, drops: 1, outbox: 0, caps: 0 })
    expect((await database.db.selectFrom("access_request_drop").select("reason").executeTakeFirstOrThrow()).reason).toBe("fill_time")
  })

  it("exactly 3.0 s passes", async () => {
    expectReceived(await send(valid({ proof: proofAged(3_000) })))
    expect((await counts()).requests).toBe(1)
  })

  it("a client-reported elapsed time is an unknown field, not a pass", async () => {
    const body = { ...valid(), elapsedMs: 30_000 }
    delete (body as Record<string, unknown>).proof
    expect((await send(body)).json().error.fields).toEqual(["body.unknown_field"])
  })

  it("honeypot and too-fast drops count toward the per-IP limit", async () => {
    await send(valid({ kiwi: "x" }))
    await send(valid({ proof: proofAged(100) }))
    expectReceived(await send(valid()))
    const fourth = await send(valid({ email: "bola@example.com" }))
    expect(fourth.statusCode).toBe(429)
    expect(fourth.json().error.code).toBe("rate_limited_ip")
  })

  it("every silent outcome returns byte-identical status, headers and body to a real success", async () => {
    const strip = (r: LightMyRequestResponse) => {
      const headers = { ...r.headers }
      delete headers.date
      return { status: r.statusCode, headers, body: r.body }
    }
    const real = strip(await send(valid({ email: "real@example.com" }), { ip: "198.51.100.1" }))
    const honeypot = strip(await send(valid({ kiwi: "x" }), { ip: "198.51.100.2" }))
    const tooFast = strip(await send(valid({ proof: proofAged(10) }), { ip: "198.51.100.3" }))
    const coalesced = strip(await send(valid({ email: "REAL@example.com" }), { ip: "198.51.100.4" }))
    expect(honeypot).toEqual(real)
    expect(tooFast).toEqual(real)
    expect(coalesced).toEqual(real)
    expect(real.headers["content-length"]).toBe("21")
  })
})

describe("per-IP limit (AC 11.8)", () => {
  it("the 3rd in an hour is accepted, the 4th refused with Retry-After 600", async () => {
    for (const minute of [0, 20, 40]) {
      clock.set(new Date(Date.parse(T0) + minute * 60_000))
      expectReceived(await send(valid({ email: `v${minute}@example.com`, proof: proofAged() })))
    }
    clock.set(new Date(Date.parse(T0) + 50 * 60_000))
    const response = await send(valid({ email: "v50@example.com", proof: proofAged() }))
    expect(response.statusCode).toBe(429)
    expect(response.json()).toEqual({ error: { code: "rate_limited_ip", message: "Too many requests from this network. Try again later." } })
    expect(response.headers["retry-after"]).toBe("600")
    expect(response.headers["cache-control"]).toBe("no-store")
    expect((await counts()).requests).toBe(3)
  })

  it("a refusal doesn't extend the window: 1 h after the first, one more is accepted", async () => {
    for (const minute of [0, 20, 40, 50]) {
      clock.set(new Date(Date.parse(T0) + minute * 60_000))
      await send(valid({ email: `v${minute}@example.com`, proof: proofAged() }))
    }
    clock.set(new Date(Date.parse(T0) + 60 * 60_000 + 1_000))
    expectReceived(await send(valid({ email: "late@example.com", proof: proofAged() })))
  })

  it("the 10th in a rolling day is accepted, the 11th refused", async () => {
    for (let i = 0; i < 10; i++) {
      clock.set(new Date(Date.parse(T0) + i * 2 * 3_600_000))
      expectReceived(await send(valid({ email: `d${i}@example.com`, proof: proofAged() })))
    }
    clock.set(new Date(Date.parse(T0) + 21 * 3_600_000))
    const response = await send(valid({ email: "d10@example.com", proof: proofAged() }))
    expect(response.statusCode).toBe(429)
    expect(response.headers["retry-after"]).toBe(String(3 * 3_600))
  })

  it("a forged X-Forwarded-For entry doesn't reset the limit", async () => {
    for (let i = 0; i < 3; i++) await send(valid({ email: `f${i}@example.com` }))
    const forged = await send(valid({ email: "f3@example.com" }), { headers: { "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 200)}, ${VISITOR}` } })
    expect(forged.statusCode).toBe(429)
  })

  it("different visitors behind the proxy have separate limits", async () => {
    for (let i = 0; i < 3; i++) await send(valid({ email: `a${i}@example.com` }), { ip: "198.51.100.10" })
    expectReceived(await send(valid({ email: "b@example.com" }), { ip: "198.51.100.11" }))
  })

  it("never stores the raw IP", async () => {
    await send(valid())
    const dump = JSON.stringify(await database.db.selectFrom("access_request").selectAll().execute())
    expect(dump).not.toContain(VISITOR)
    expect(dump).not.toContain(PROXY)
  })
})

describe("global daily cap (AC 11.9)", () => {
  async function seedAccepted(n: number, at = T0): Promise<void> {
    for (let i = 0; i < n; i++) {
      const id = crypto.randomUUID()
      await sql`insert into access_request (id, email, email_key, note, created_at, ip_hash, window_id)
        values (${id}, ${`seed${i}@example.com`}, ${`seed${i}@example.com`}, '', ${at}, ${"c".repeat(64)}, ${id})`.execute(database.db)
    }
  }

  it("the 50th is accepted and the 51st refused with the daily message and seconds to 00:00 UTC", async () => {
    await seedAccepted(49)
    expectReceived(await send(valid({ email: "fifty@example.com" })))
    const response = await send(valid({ email: "fiftyone@example.com" }), { ip: "198.51.100.99" })
    expect(response.statusCode).toBe(429)
    expect(response.json()).toEqual({ error: { code: "rate_limited_global", message: "Eve can't take more requests today. Try again tomorrow." } })
    expect(response.headers["retry-after"]).toBe(String(14 * 3_600))
    expect((await counts()).requests).toBe(50)
  })

  it("the first refusal of the day enqueues one cap alert; later refusals add none", async () => {
    await seedAccepted(50)
    for (let i = 0; i < 3; i++) expect((await send(valid({ email: `x${i}@example.com` }), { ip: `198.51.100.${120 + i}` })).statusCode).toBe(429)
    const caps = await database.db.selectFrom("notification_outbox").select([sql<string>`local_day::text`.as("day"), "status"]).where("kind", "=", "access_request_cap").execute()
    expect(caps).toEqual([{ day: "2026-10-21", status: "pending" }])
  })

  it("a honeypot request at the cap gets the same 429 as a real one", async () => {
    await seedAccepted(50)
    const real = await send(valid({ email: "x@example.com" }), { ip: "198.51.100.130" })
    const bot = await send(valid({ kiwi: "x" }), { ip: "198.51.100.131" })
    expect(bot.statusCode).toBe(429)
    expect(bot.body).toBe(real.body)
    expect((await counts()).drops).toBe(0)
  })

  it("resets at 00:00 UTC", async () => {
    await seedAccepted(50, "2026-10-21T23:00:00.000Z")
    clock.set("2026-10-21T23:59:59.000Z")
    expect((await send(valid({ proof: proofAged() }))).statusCode).toBe(429)
    clock.set("2026-10-22T00:00:00.000Z")
    expectReceived(await send(valid({ email: "new-day@example.com", proof: proofAged() }), { ip: "198.51.100.140" }))
  })
})

describe("coalescing (AC 11.19)", () => {
  it("a second request from the same email (any case) within 24 h joins the window with no new outbox row", async () => {
    expectReceived(await send(valid({ note: "first" })))
    clock.set(new Date(Date.parse(T0) + 3_600_000))
    expectReceived(await send(valid({ email: "ADA@Example.com", note: "second", proof: proofAged() }), { ip: "198.51.100.50" }))
    const rows = await storedRequests()
    expect(rows).toHaveLength(2)
    expect(rows[1]!.window_id).toBe(rows[0]!.id)
    expect(rows[1]!.email).toBe("ADA@Example.com")
    expect((await counts()).outbox).toBe(1)
  })

  it("a repeat after the window's email was sent is stored as sent and sends nothing new", async () => {
    await send(valid())
    await database.db.updateTable("notification_outbox").set({ status: "sent", sent_at: new Date(T0) }).execute()
    await database.db.updateTable("access_request").set({ status: "sent" }).execute()
    clock.set(new Date(Date.parse(T0) + 2 * 3_600_000))
    expectReceived(await send(valid({ proof: proofAged() }), { ip: "198.51.100.51" }))
    const rows = await storedRequests()
    expect(rows.map((r) => r.status)).toEqual(["sent", "sent"])
    expect((await counts()).outbox).toBe(1)
  })

  it("24 hours and 1 second after the first opens a new window", async () => {
    await send(valid())
    clock.set(new Date(Date.parse(T0) + 24 * 3_600_000 + 1_000))
    expectReceived(await send(valid({ proof: proofAged() }), { ip: "198.51.100.52" }))
    const rows = await storedRequests()
    expect(rows[1]!.window_id).toBe(rows[1]!.id)
    expect((await counts()).outbox).toBe(2)
  })

  it("different emails are separate windows", async () => {
    await send(valid())
    await send(valid({ email: "bola@example.com" }))
    expect((await counts()).outbox).toBe(2)
  })
})

describe("the Operator address never appears (AC 11.22)", () => {
  it("no response body or header from either route contains NOTIFY_TO", async () => {
    const responses = [
      await fastify.inject({ method: "GET", url: ACCESS_REQUEST_PROOF_PATH }),
      await send(valid()),
      await send(valid({ email: "bad" })),
      await send(valid(), { origin: "https://evil.example" }),
      await sendRaw("x", { contentType: "text/plain" }),
      await sendRaw("{"),
      await send(valid({ kiwi: "x" })),
      await send(valid({ email: "b@example.com" })),
      await send(valid({ email: "c@example.com" })),
    ]
    expect(responses.at(-1)!.statusCode).toBe(429)
    for (const response of responses) {
      expect(response.body.toLowerCase()).not.toContain(OPERATOR)
      expect(JSON.stringify(response.headers).toLowerCase()).not.toContain(OPERATOR)
    }
  })
})
