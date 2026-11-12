import type { INestApplication, INestApplicationContext } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { ACCESS_REQUEST_PATH } from "@eve/contracts"
import type { FastifyInstance } from "fastify"
import { sql } from "kysely"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { issueProof } from "../src/access-request/fill-proof.js"
import { anthropicConfig } from "../src/config/env.js"
import { GmailSmtpMailer } from "../src/notification/mailer.js"
import { type MailerConfig, mailerConfig } from "../src/notification/mailer-config.js"
import { NotificationSender } from "../src/notification/notification-sender.js"
import { AccessRequestOutboxRepository } from "../src/notification/access-request-outbox.repository.js"
import { NotificationWorkerModule } from "../src/notification/notification.module.js"
import { CLOCK } from "../src/shared/clock.js"
import { FakeSmtp, type ReceivedEmail, header } from "./support/fake-smtp.js"
import { asOperator } from "./support/operator-scope.js"
import { type TestDatabase, startMigratedDatabase } from "./support/postgres.js"
import { PUBLIC_ORIGIN, createTestApp, testAccessRequestConfig } from "./support/test-app.js"
import { TestClock } from "./support/test-clock.js"

/**
 * request-access.feature sender scenarios: the real api endpoint stores
 * requests, the real NotificationSender with the production Gmail SMTP adapter
 * delivers to an in-process fake SMTP server on 127.0.0.1. Nothing reaches a
 * real mail server; the sender's only transport is 127.0.0.1:<fake port>.
 */
const SENDER = "eve-sender@example.test"
const APP_PASSWORD = "synthetictestpassword"
const OPERATOR = "operator@eve.example"
const T0 = "2026-10-21T09:15:00.000Z"

let database: TestDatabase
let app: INestApplication
let fastify: FastifyInstance
let smtp: FakeSmtp
let config: MailerConfig
let worker: INestApplicationContext
let sender: NotificationSender
const clock = new TestClock(T0)
const proofKey = testAccessRequestConfig().keys.proofKey()
let ipCounter = 0

async function bootWorker(mailerConfigValue: MailerConfig | null): Promise<INestApplicationContext> {
  const { ConfigModule } = await import("../src/config/config.module.js")
  const { DatabaseModule } = await import("../src/db/database.module.js")
  const { ClockModule } = await import("../src/shared/clock.js")
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ databaseUrl: database.url, statementTimeoutMs: 60_000, anthropic: anthropicConfig(undefined, "claude-haiku-5-5") }),
      ClockModule,
      DatabaseModule,
      NotificationWorkerModule.forRoot(
        mailerConfigValue,
        mailerConfigValue ? { mailer: new GmailSmtpMailer(mailerConfigValue, { connectionTimeout: 2_000, greetingTimeout: 2_000, socketTimeout: 1_500 }) } : {}
      ),
    ],
  })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile()
  await moduleRef.init()
  return moduleRef
}

beforeAll(async () => {
  database = await startMigratedDatabase()
  smtp = new FakeSmtp(SENDER, APP_PASSWORD)
  await smtp.start()
  config = mailerConfig({ user: SENDER, to: OPERATOR, dashboardOrigin: PUBLIC_ORIGIN, transport: { host: "127.0.0.1", port: smtp.port, secure: false, ignoreTLS: true }, appPassword: APP_PASSWORD })
  app = await createTestApp({ databaseUrl: database.url, clock })
  fastify = app.getHttpAdapter().getInstance() as FastifyInstance
  worker = await bootWorker(config)
  // EPIC-0002 A1: the worker runs the sender in the Operator's scope (NotificationJobs.sendDue).
  sender = asOperator(worker, worker.get(NotificationSender))
})

beforeEach(async () => {
  clock.set(T0)
  smtp.reset()
  await database.db.deleteFrom("access_request").execute()
  await database.db.deleteFrom("access_request_drop").execute()
  await database.db.deleteFrom("notification_outbox").execute()
  await database.db.updateTable("control_state").set({ global_paused: false, cost_paused: false }).execute()
})

afterAll(async () => {
  await worker?.close()
  await app?.close()
  await smtp?.stop()
  await database?.stop()
})

async function request(email: string, note = "", ip?: string): Promise<void> {
  ipCounter += 1
  const response = await fastify.inject({
    method: "POST",
    url: ACCESS_REQUEST_PATH,
    payload: JSON.stringify({ email, note, proof: issueProof(clock.now().getTime() - 5_000, proofKey), kiwi: "" }),
    headers: { origin: PUBLIC_ORIGIN, "content-type": "application/json", "x-forwarded-for": ip ?? `198.51.100.${ipCounter % 250}` },
    remoteAddress: "10.0.0.2",
  })
  expect(response.statusCode).toBe(202)
}

function at(iso: string): void {
  clock.set(iso)
}

/** Body of a single-part text/plain message, decoded. */
function body(message: ReceivedEmail): string {
  const [head = "", ...rest] = message.raw.split("\r\n\r\n")
  const raw = rest.join("\r\n\r\n")
  const encoding = /^Content-Transfer-Encoding: (\S+)/im.exec(head)?.[1]?.toLowerCase()
  if (encoding === "base64") return Buffer.from(raw.replace(/\s+/g, ""), "base64").toString("utf8")
  if (encoding === "quoted-printable") {
    const bytes = raw.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    return Buffer.from(bytes, "latin1").toString("utf8").replace(/\r\n/g, "\n")
  }
  return raw.replace(/\r\n/g, "\n")
}

const forVisitor = (email: string) => smtp.received.filter((m) => header(m.raw, "Reply-To") === email)

describe("Operator email delivery", () => {
  it("goes only to the Operator, subject as specified, Reply-To the visitor, plain text, WAT time, no IP", async () => {
    await request("ada@example.com", "Met you at DevFest Lagos", "203.0.113.7")
    expect(await sender.sendDue()).toMatchObject({ sent: 1 })
    expect(smtp.received).toHaveLength(1)
    const [message] = smtp.received
    expect(message!.to).toEqual([OPERATOR])
    expect(header(message!.raw, "To")).toBe(OPERATOR)
    expect(header(message!.raw, "Cc")).toBeUndefined()
    expect(header(message!.raw, "Bcc")).toBeUndefined()
    expect(header(message!.raw, "Subject")).toBe("Eve access request from ada@example.com")
    expect(header(message!.raw, "Reply-To")).toBe("ada@example.com")
    expect(header(message!.raw, "Content-Type")).toMatch(/^text\/plain/)
    expect(message!.raw).not.toMatch(/text\/html/i)
    const text = body(message!)
    expect(text).toContain("ada@example.com asked for access to Eve.")
    expect(text).toContain("Met you at DevFest Lagos")
    expect(text).toContain("10:15 WAT")
    expect(text).not.toContain("203.0.113.7")
    expect(text).not.toMatch(/https?:\/\//)
    const rows = await database.db.selectFrom("access_request").select("status").execute()
    expect(rows.map((r) => r.status)).toEqual(["sent"])
  })

  it("header-injection text in the note stays in the body", async () => {
    await request("ada@example.com", "Hi\r\nBcc: victim@example.net\r\nSubject: Win")
    await sender.sendDue()
    const [message] = smtp.received
    expect(message!.to).toEqual([OPERATOR])
    expect(header(message!.raw, "Bcc")).toBeUndefined()
    expect(header(message!.raw, "Subject")).toBe("Eve access request from ada@example.com")
    const head = message!.raw.split("\r\n\r\n")[0]!
    expect(head).not.toContain("victim@example.net")
    expect(body(message!)).toContain("Hi\nBcc: victim@example.net\nSubject: Win")
  })

  it("markup in the note is kept literally in a text/plain part", async () => {
    await request("ada@example.com", "<b>hi</b><script>alert(1)</script>")
    await sender.sendDue()
    expect(body(smtp.received[0]!)).toContain("<b>hi</b><script>alert(1)</script>")
  })

  it("a stored email that fails the allow-list is refused at send time and nothing reaches SMTP", async () => {
    const id = crypto.randomUUID()
    await sql`insert into access_request (id, email, email_key, note, created_at, ip_hash, window_id) values (${id}, ${"a@b.co>x"}, ${"a@b.co>x"}, '', now(), null, ${id})`.execute(database.db)
    await sql`insert into notification_outbox (candidate_id, id, application_id, kind, created_at, access_request_window_id) values (null, ${crypto.randomUUID()}, null, 'access_request', now(), ${id})`.execute(database.db)
    await sender.sendDue()
    expect(smtp.received).toHaveLength(0)
    const outbox = await database.db.selectFrom("notification_outbox").select(["status", "last_error"]).executeTakeFirstOrThrow()
    expect(outbox).toEqual({ status: "pending", last_error: "send_refused" })
  })
})

describe("coalescing at send time (AC 11.19)", () => {
  it("a second request before the send joins the same email, notes oldest first, count 2", async () => {
    await database.db.updateTable("control_state").set({ cost_paused: true }).execute()
    at("2026-10-21T10:00:00.000Z")
    await request("ada@example.com", "First note")
    at("2026-10-21T10:30:00.000Z")
    await request(" ADA@Example.com ", "Second note", "198.51.100.9")
    expect(await sender.sendDue()).toMatchObject({ sent: 0 })
    await database.db.updateTable("control_state").set({ cost_paused: false }).execute()
    await sender.sendDue()
    expect(smtp.received).toHaveLength(1)
    const text = body(smtp.received[0]!)
    expect(text).toContain("2 requests from this address in 24 hours.")
    expect(text.indexOf("First note")).toBeLessThan(text.indexOf("Second note"))
    expect((await database.db.selectFrom("access_request").select("status").execute()).map((r) => r.status)).toEqual(["sent", "sent"])
  })

  it("a repeat after the send is stored as sent and sends nothing new", async () => {
    at("2026-10-21T10:00:00.000Z")
    await request("ada@example.com")
    await sender.sendDue()
    at("2026-10-21T18:00:00.000Z")
    await request("ada@example.com")
    await sender.sendDue()
    expect(forVisitor("ada@example.com")).toHaveLength(1)
    expect((await database.db.selectFrom("access_request").select("status").orderBy("created_at").execute()).map((r) => r.status)).toEqual(["sent", "sent"])
  })

  it("24 hours and 1 second later sends a new email", async () => {
    at("2026-10-20T10:00:00.000Z")
    await request("ada@example.com")
    await sender.sendDue()
    at("2026-10-21T10:00:01.000Z")
    await request("ada@example.com")
    await sender.sendDue()
    expect(forVisitor("ada@example.com")).toHaveLength(2)
  })

  it("6 requests: one email, count 6, notes n1 to n5 in order", async () => {
    await database.db.updateTable("control_state").set({ global_paused: true }).execute()
    for (let i = 1; i <= 6; i++) {
      at(new Date(Date.parse("2026-10-21T10:00:00.000Z") + i * 15 * 60_000).toISOString())
      await request("ada@example.com", `n${i}`, `198.51.100.${200 + i}`)
    }
    await database.db.updateTable("control_state").set({ global_paused: false }).execute()
    await sender.sendDue()
    expect(smtp.received).toHaveLength(1)
    const text = body(smtp.received[0]!)
    expect(text).toContain("6 requests from this address in 24 hours.")
    expect(text).toMatch(/n1[\s\S]*n2[\s\S]*n3[\s\S]*n4[\s\S]*n5/)
    expect(text).not.toContain("n6")
    expect(text).toContain("Only the first 5 notes are included.")
  })

  it("different emails are two emails", async () => {
    await request("ada@example.com")
    at("2026-10-21T09:20:00.000Z")
    await request("bola@example.com")
    await sender.sendDue()
    expect(smtp.received).toHaveLength(2)
  })
})

describe("pauses (AC 11.25)", () => {
  it("during a cost pause the access-request email waits, and the cap alert still sends", async () => {
    await database.db.updateTable("control_state").set({ cost_paused: true }).execute()
    await request("ada@example.com")
    await sql`insert into notification_outbox (candidate_id, id, application_id, kind, created_at, local_day) values (null, ${crypto.randomUUID()}, null, 'access_request_cap', now(), '2026-10-21')`.execute(database.db)
    await sender.sendDue()
    expect(smtp.received.map((m) => header(m.raw, "Subject"))).toEqual(["Eve reached its daily limit of access requests on 21 Oct 2026"])
    expect((await database.db.selectFrom("notification_outbox").select("status").where("kind", "=", "access_request").executeTakeFirstOrThrow()).status).toBe("pending")
  })
})

describe("cap alert", () => {
  it("is sent once with the day's accepted count, no Reply-To and no visitor data", async () => {
    for (let i = 0; i < 50; i++) {
      const id = crypto.randomUUID()
      await sql`insert into access_request (id, email, email_key, note, created_at, ip_hash, window_id) values (${id}, ${`s${i}@example.com`}, ${`s${i}@example.com`}, '', ${T0}, null, ${id})`.execute(database.db)
    }
    const refused = await fastify.inject({
      method: "POST",
      url: ACCESS_REQUEST_PATH,
      payload: JSON.stringify({ email: "late@example.com", proof: issueProof(clock.now().getTime() - 5_000, proofKey) }),
      headers: { origin: PUBLIC_ORIGIN, "content-type": "application/json", "x-forwarded-for": "198.51.100.77" },
      remoteAddress: "10.0.0.2",
    })
    expect(refused.statusCode).toBe(429)
    await sender.sendDue()
    expect(smtp.received).toHaveLength(1)
    const [message] = smtp.received
    expect(message!.to).toEqual([OPERATOR])
    expect(header(message!.raw, "Reply-To")).toBeUndefined()
    const text = body(message!)
    expect(text).toContain("Eve accepted 50 access requests on 21 Oct 2026 (UTC), the most it takes in one day.")
    expect(text).not.toContain("example.com")
  })
})

describe("retries and unconfigured mailer (AC 11.15, 11.16)", () => {
  it("retries at +1, +5, +15 and +60 minutes, then fails, and never tries again", async () => {
    smtp.reset("refuse_send")
    at("2026-10-21T10:00:00.000Z")
    await request("ada@example.com")
    const attempts: string[] = []
    for (let minute = 0; minute <= 120; minute++) {
      at(new Date(Date.parse("2026-10-21T10:00:00.000Z") + minute * 60_000).toISOString())
      const before = smtp.authAttempts.length
      await sender.sendDue()
      if (smtp.authAttempts.length > before) attempts.push(clock.now().toISOString().slice(11, 16))
    }
    expect(attempts).toEqual(["10:00", "10:01", "10:06", "10:21", "11:21"])
    const outbox = await database.db.selectFrom("notification_outbox").select(["status", "attempts"]).executeTakeFirstOrThrow()
    expect(outbox).toEqual({ status: "failed", attempts: 5 })
    expect((await database.db.selectFrom("access_request").select("status").executeTakeFirstOrThrow()).status).toBe("failed")
  })

  it("with the mailer unconfigured nothing is sent; once configured, each window sends exactly once", async () => {
    const offline = await bootWorker(null)
    try {
      await request("ada@example.com")
      at("2026-10-21T09:16:00.000Z")
      await request("bola@example.com")
      expect(await offline.get(NotificationSender).sendDue()).toMatchObject({ skipped: "not_configured" })
      expect(smtp.received).toHaveLength(0)
      expect((await database.db.selectFrom("notification_outbox").select("status").execute()).map((r) => r.status)).toEqual(["pending", "pending"])
    } finally {
      await offline.close()
    }
    await sender.sendDue()
    await sender.sendDue()
    expect(smtp.received).toHaveLength(2)
    expect((await database.db.selectFrom("notification_outbox").select("status").execute()).map((r) => r.status)).toEqual(["sent", "sent"])
  })

  it("an interrupted access-request send marks its requests failed", async () => {
    await request("ada@example.com")
    await database.db.updateTable("notification_outbox").set({ status: "sending" }).execute()
    expect(await worker.get(AccessRequestOutboxRepository).failInterrupted(clock.now())).toBe(1)
    expect((await database.db.selectFrom("access_request").select("status").executeTakeFirstOrThrow()).status).toBe("failed")
  })

  it("a window whose requests were deleted closes as sent with nothing mailed", async () => {
    await request("ada@example.com")
    await database.db.deleteFrom("access_request").execute()
    expect(await sender.sendDue()).toMatchObject({ sent: 1 })
    expect(smtp.received).toHaveLength(0)
  })

  it("the response never waits for the mail server", async () => {
    smtp.reset("hang")
    const started = Date.now()
    await request("ada@example.com")
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
