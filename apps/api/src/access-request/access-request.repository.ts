import { randomUUID } from "node:crypto"

import { Injectable } from "@nestjs/common"
import { sql } from "../db/sql.js"

import type { AccessRequestDropReason, AccessRequestStatus } from "../db/schema.js"
import { API_STATEMENT_TIMEOUT_MS } from "../db/statement-timeouts.js"
import { type InstallationTx, TenantDatabase } from "../db/tenant-database.js"
import { applyTransactionTimeouts, transactionTimeouts } from "../db/transaction-timeouts.js"
import { decideGlobal, decidePerIp, utcDayStart } from "./rate-limit.js"

const DAY_MS = 24 * 3_600_000
type Tx = InstallationTx
/** One installation-wide lock: every count, insert and outbox write happens after it. */
const LOCK_NAME = "eve.access_request"
/** 2 s advisory-lock wait (architecture.r1), strictly under the api's statement timeout (QA-G5-2). */
export const SUBMIT_TIMEOUTS = transactionTimeouts(2_000, API_STATEMENT_TIMEOUT_MS)

export type AccessRequestLimitsInput = Readonly<{ perIpHour: number; perIpDay: number; globalDay: number; perIpEnabled: boolean }>

export type SubmissionInput = Readonly<{
  now: Date
  ipHash: string
  limits: AccessRequestLimitsInput
  /** null: accept. Otherwise a silent drop with this reason. */
  drop: AccessRequestDropReason | null
  email: string
  emailKey: string
  note: string
}>

export type SubmissionOutcome =
  | { kind: "accepted"; windowId: string; newWindow: boolean }
  | { kind: "dropped" }
  | { kind: "rate_limited_ip"; retryAfterSeconds: number }
  | { kind: "rate_limited_global"; retryAfterSeconds: number }

/**
 * The single place where limits, drops, coalescing and the outbox are decided
 * (architecture.r1 7.4 to 7.8). One transaction, serialized by one advisory lock,
 * with a 2 s lock timeout.
 */
@Injectable()
export class AccessRequestRepository {
  constructor(private readonly tenant: TenantDatabase) {}

  /**
   * C36 (architecture r4 Tenancy 2a): requests, drops and their outbox rows are installation data,
   * read and written only in `forInstallation`; the outbox rows carry no Candidate ID.
   */
  async submit(input: SubmissionInput): Promise<SubmissionOutcome> {
    return this.tenant.forInstallation(async (trx) => {
      await applyTransactionTimeouts(trx, SUBMIT_TIMEOUTS)
      await sql`select pg_advisory_xact_lock(hashtext(${LOCK_NAME}))`.execute(trx)

      if (input.limits.perIpEnabled) {
        const perIp = decidePerIp(await this.ipEntries(trx, input.ipHash, input.now), input.now, { perHour: input.limits.perIpHour, perDay: input.limits.perIpDay })
        if (!perIp.allowed) return { kind: "rate_limited_ip", retryAfterSeconds: perIp.retryAfterSeconds }
      }

      const global = decideGlobal(await this.acceptedToday(trx, input.now), input.now, input.limits.globalDay)
      if (!global.allowed) {
        await this.enqueueCapAlert(trx, input.now)
        return { kind: "rate_limited_global", retryAfterSeconds: global.retryAfterSeconds }
      }

      if (input.drop !== null) {
        await trx.insertInto("access_request_drop").values({ id: randomUUID(), ip_hash: input.ipHash, reason: input.drop, created_at: input.now }).execute()
        return { kind: "dropped" }
      }
      return this.accept(trx, input)
    })
  }

  private async accept(trx: Tx, input: SubmissionInput): Promise<SubmissionOutcome> {
    const id = randomUUID()
    const window = await trx
      .selectFrom("access_request")
      .select("id")
      .where("email_key", "=", input.emailKey)
      .where("created_at", ">", new Date(input.now.getTime() - DAY_MS))
      .whereRef("id", "=", "window_id")
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst()
    const windowId = window?.id ?? id
    const status = window ? await this.windowStatus(trx, window.id) : "waiting"
    await trx
      .insertInto("access_request")
      .values({ id, email: input.email, email_key: input.emailKey, note: input.note, created_at: input.now, ip_hash: input.ipHash, window_id: windowId, status })
      .execute()
    if (!window) {
      await trx
        .insertInto("notification_outbox")
        .values({ id: randomUUID(), candidate_id: null, application_id: null, kind: "access_request", created_at: input.now, sent_at: null, access_request_window_id: id })
        .execute()
    }
    return { kind: "accepted", windowId, newWindow: !window }
  }

  /** A joining request mirrors the window's finished email; otherwise it waits with it. */
  private async windowStatus(trx: Tx, windowId: string): Promise<AccessRequestStatus> {
    const outbox = await trx.selectFrom("notification_outbox").select("status").where("kind", "=", "access_request").where("access_request_window_id", "=", windowId).executeTakeFirst()
    return outbox?.status === "sent" || outbox?.status === "failed" ? outbox.status : "waiting"
  }

  private async ipEntries(trx: Tx, ipHash: string, now: Date): Promise<Date[]> {
    const since = new Date(now.getTime() - DAY_MS)
    const rows = await trx
      .selectFrom("access_request")
      .select("created_at")
      .where("ip_hash", "=", ipHash)
      .where("created_at", ">", since)
      .unionAll(trx.selectFrom("access_request_drop").select("created_at").where("ip_hash", "=", ipHash).where("created_at", ">", since))
      .execute()
    return rows.map((row) => row.created_at)
  }

  private async acceptedToday(trx: Tx, now: Date): Promise<number> {
    const row = await trx
      .selectFrom("access_request")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("created_at", ">=", utcDayStart(now))
      .executeTakeFirstOrThrow()
    return Number(row.count)
  }

  /** The first refusal of a UTC day enqueues one cap alert; later ones do nothing. */
  private async enqueueCapAlert(trx: Tx, now: Date): Promise<void> {
    await trx
      .insertInto("notification_outbox")
      .values({ id: randomUUID(), candidate_id: null, application_id: null, kind: "access_request_cap", created_at: now, sent_at: null, local_day: utcDayStart(now).toISOString().slice(0, 10) })
      .onConflict((oc) => oc.column("local_day").where("kind", "=", "access_request_cap").doNothing())
      .execute()
  }
}
