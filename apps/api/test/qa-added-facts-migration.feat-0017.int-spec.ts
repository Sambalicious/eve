import { randomUUID } from "node:crypto"

import { type Kysely, sql } from "kysely"
import { Migrator } from "kysely/migration"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"

import { createDatabase } from "../src/db/create-database.js"
import { grantDatabaseAccess } from "../src/db/database-roles.js"
import { migrationsFor } from "../src/db/migrations/index.js"
import { ADDED_FACTS_MARKER } from "../src/db/migrations/0042-added-facts.js"
import { rolesFor, urlFor } from "./support/postgres-cluster.js"

/**
 * FEAT-0017 QA gate [6a]: migration 0042-added-facts on real Postgres with two Candidates, and the Level 2 rollback
 * runbook SQL (devops-config.r1.md "Rollback runbook", five zero-counts). Sources: devops-config.r1.md (up, down, up;
 * rollback statements a to d and the five counts), architecture.md "Data model and migration", threat-model.md
 * (cross-Candidate visibility is a rollback trigger). Seeds and the counts use the bootstrap superuser; the RLS and
 * rollback checks use the runtime role bound to one Candidate per transaction, as the runbook does.
 */
const ALL = migrationsFor({ operatorGoogleSub: "google-sub-ada-0042" })
type Db = Kysely<unknown>
let cluster: Db
let admin: Db
let owner: Db
let runtime: Db
let name: string
const A = { candidate: "", application: "", queued: "", blocked: "", deleted: "", confirmed: "" }
const B = { candidate: "", application: "" }

const migrator = (upTo?: string) => new Migrator({ db: owner, provider: { getMigrations: async () => (upTo ? Object.fromEntries(Object.entries(ALL).filter(([key]) => key <= upTo)) : ALL) } })

async function addCandidate(email: string): Promise<string> {
  return (await sql<{ id: string }>`insert into candidate (email, google_sub, role, state) values (${email}, ${`sub-${email}`}, 'candidate', 'active') returning id::text as id`.execute(admin)).rows[0]!.id
}

async function seedApplication(candidateId: string, extra: { state?: string; columns?: string } = {}): Promise<string> {
  const posting = randomUUID()
  const url = `https://boards.greenhouse.io/acme/jobs/${posting}`
  await sql`insert into job_posting (id, application_url, requisition_id, apply_url, application_system, apply_mode, origin, title, title_folded, company, structured, role_family, discovered_at)
    values (${posting}::uuid, ${url}, ${posting.slice(0, 12)}, ${url}, 'greenhouse', 'automatic', 'employer_board', 'Engineer', 'engineer', 'Acme', '{}', 'senior_frontend', now())`.execute(admin)
  const id = randomUUID()
  await sql`insert into application (candidate_id, id, job_posting_id, application_url, requisition_id, company, role_title, state, career_profile_version, created_at, updated_at)
    values (${candidateId}::uuid, ${id}::uuid, ${posting}::uuid, ${url}, ${posting.slice(0, 12)}, 'Acme', 'Engineer', ${extra.state ?? "documents_ready"}, 1, now(), now())`.execute(admin)
  return id
}

async function seedFact(candidateId: string, applicationId: string, term: string): Promise<void> {
  await sql`insert into application_added_fact (id, candidate_id, application_id, kind, text, text_key, term, affirmed_at, created_at, updated_at)
    values (${randomUUID()}::uuid, ${candidateId}::uuid, ${applicationId}::uuid, 'skill_only', ${term}, ${term.toLowerCase()}, ${term}, now(), now(), now())`.execute(admin)
}

/** One transaction bound to exactly one Candidate, as `deploy.md` "Running SQL by hand against Candidate tables (after 0022)" requires. */
async function bound<T>(db: Db, candidateId: string, run: (tx: Kysely<unknown>) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`select set_config('eve.candidate_id', ${candidateId}, true), public.bind_candidate(${candidateId}::uuid)`.execute(tx)
    return run(tx)
  })
}

const count = async (query: ReturnType<typeof sql<{ n: number }>>) => (await query.execute(admin)).rows[0]!.n

beforeAll(async () => {
  cluster = createDatabase(inject("postgresAdminUrl")) as unknown as Db
  name = `ja_af_${randomUUID().replaceAll("-", "").slice(0, 16)}`
  await sql`create database ${sql.id(name)}`.execute(cluster)
  const clusterUrl = inject("postgresAdminUrl")
  const roles = rolesFor(name)
  admin = createDatabase(urlFor(clusterUrl, undefined, name)) as unknown as Db
  await grantDatabaseAccess(admin, roles)
  owner = createDatabase(urlFor(clusterUrl, roles.owner, name)) as unknown as Db
  const { error } = await migrator("0041-lead-policy-binding").migrateToLatest()
  if (error) throw error
  A.candidate = await addCandidate("a-0042@example.test")
  B.candidate = await addCandidate("b-0042@example.test")
  runtime = createDatabase(urlFor(clusterUrl, roles.runtime, name)) as unknown as Db
})

afterAll(async () => {
  for (const db of [runtime, owner, admin]) await db?.destroy()
  await sql`drop database if exists ${sql.id(name)} with (force)`.execute(cluster)
  await cluster.destroy()
})

describe("QA FEAT-0017: migration 0042-added-facts, up, down, up with two Candidates", () => {
  it("is the last registered migration and its marker is absent before it runs", async () => {
    expect(Object.keys(ALL).at(-1)).toBe(ADDED_FACTS_MARKER)
    expect((await sql`select 1 from migration_marker where name = ${ADDED_FACTS_MARKER}`.execute(admin)).rows).toEqual([])
    expect((await sql`select 1 from pg_tables where tablename = 'application_added_fact'`.execute(admin)).rows).toEqual([])
  })

  it("up: existing rows keep their values and read the new columns at their defaults (no backfill)", async () => {
    A.application = await seedApplication(A.candidate)
    B.application = await seedApplication(B.candidate)
    const { error } = await migrator().migrateToLatest()
    expect(error).toBeUndefined()
    expect((await sql`select 1 from migration_marker where name = ${ADDED_FACTS_MARKER}`.execute(admin)).rows).toHaveLength(1)
    const rows = (await sql<{ added_facts_version: number; added_facts_confirmed_version: number | null; added_facts_confirmed_at: Date | null; added_facts_match: unknown }>`select added_facts_version, added_facts_confirmed_version, added_facts_confirmed_at, added_facts_match from application where id = ${A.application}::uuid`.execute(admin)).rows
    expect(rows).toEqual([{ added_facts_version: 0, added_facts_confirmed_version: null, added_facts_confirmed_at: null, added_facts_match: null }])
    expect((await sql`select 1 from application_added_fact`.execute(admin)).rows).toEqual([])
  })

  it("up: the table forces RLS with the one _candidate policy naming bound_candidate and the setting", async () => {
    const flags = (await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'application_added_fact'`.execute(admin)).rows[0]
    expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true })
    const policies = (await sql<{ policyname: string; qual: string; with_check: string }>`select policyname, qual, with_check from pg_policies where tablename = 'application_added_fact'`.execute(admin)).rows
    expect(policies.map((p) => p.policyname)).toEqual(["application_added_fact_candidate"])
    for (const text of [policies[0]!.qual, policies[0]!.with_check]) expect(text).toMatch(/bound_candidate/)
  })

  it("RLS: Candidate B reads none of A's added facts and cannot write a row for A", async () => {
    await seedFact(A.candidate, A.application, "Figma")
    await seedFact(B.candidate, B.application, "Kubernetes")
    const seen = (id: string) => bound(runtime, id, async (tx) => (await sql<{ term: string }>`select term from application_added_fact order by term`.execute(tx)).rows.map((row) => row.term))
    expect(await seen(A.candidate)).toEqual(["Figma"])
    expect(await seen(B.candidate)).toEqual(["Kubernetes"])
    // Unbound: nothing.
    expect((await runtime.transaction().execute((tx) => sql`select 1 from application_added_fact`.execute(tx))).rows).toEqual([])
    // B, bound as B, cannot insert a row that carries A's candidate_id, update A's row, or delete it.
    await expect(
      bound(runtime, B.candidate, (tx) =>
        sql`insert into application_added_fact (id, candidate_id, application_id, kind, text, text_key, term, affirmed_at, created_at, updated_at)
          values (${randomUUID()}::uuid, ${A.candidate}::uuid, ${A.application}::uuid, 'skill_only', 'Sneaky', 'sneaky', 'Sneaky', now(), now(), now())`.execute(tx)
      )
    ).rejects.toThrow(/row-level security/)
    const updated = await bound(runtime, B.candidate, (tx) => sql`update application_added_fact set text = text where candidate_id = ${A.candidate}::uuid`.execute(tx))
    expect(Number(updated.numAffectedRows ?? 0)).toBe(0)
    const deleted = await bound(runtime, B.candidate, (tx) => sql`delete from application_added_fact where candidate_id = ${A.candidate}::uuid`.execute(tx))
    expect(Number(deleted.numAffectedRows ?? 0)).toBe(0)
    expect(await count(sql<{ n: number }>`select count(*)::int as n from application_added_fact where candidate_id = ${A.candidate}::uuid`)).toBe(1)
    // Re-pointing the setting inside a bound transaction: nothing visible.
    const repointed = await bound(runtime, B.candidate, async (tx) => {
      await sql`select set_config('eve.candidate_id', ${A.candidate}, true)`.execute(tx)
      return (await sql`select 1 from application_added_fact`.execute(tx)).rows
    })
    expect(repointed).toEqual([])
  })

  // SEC-R02: the composite foreign key `(application_id, candidate_id)` binds the fact's Candidate to the
  // Application's owner, so the database refuses the row the api already refuses with 404. This was the
  // `it.fails` tripwire before the key landed.
  it("Candidate B cannot attach a fact to A's Application at the database level", async () => {
    const attach = bound(runtime, B.candidate, (tx) =>
      sql`insert into application_added_fact (id, candidate_id, application_id, kind, text, text_key, term, affirmed_at, created_at, updated_at)
        values (${randomUUID()}::uuid, ${B.candidate}::uuid, ${A.application}::uuid, 'skill_only', 'CrossAttach', 'crossattach', 'CrossAttach', now(), now(), now())`.execute(tx)
    )
    try {
      await expect(attach).rejects.toThrow(/application_added_fact_application_fk/)
    } finally {
      await sql`delete from application_added_fact where term = 'CrossAttach'`.execute(admin)
    }
  })

  it("A's reads stay clean whatever B attached (the policy filters on candidate_id)", async () => {
    const aSees = await bound(runtime, A.candidate, async (tx) => (await sql<{ term: string }>`select term from application_added_fact order by term`.execute(tx)).rows.map((row) => row.term))
    expect(aSees).toEqual(["Figma"])
  })

  it("the constraints refuse a skill-only fact with a sentence, a one-liner without its role, an unpaired confirmation and the old causes' replacements", async () => {
    const insert = (kind: string, text: string, term: string | null, role: string | null, snapshot: string | null) =>
      sql`insert into application_added_fact (id, candidate_id, application_id, kind, text, text_key, term, role_section_id, role_snapshot, affirmed_at, created_at, updated_at)
        values (${randomUUID()}::uuid, ${A.candidate}::uuid, ${A.application}::uuid, ${kind}, ${text}, ${text.toLowerCase()}, ${term}, ${role}, ${snapshot}::jsonb, now(), now(), now())`.execute(admin)
    await expect(insert("skill_only", "Built Figma plugins", "Figma2", null, null)).rejects.toThrow(/skill_only_text/)
    await expect(insert("one_liner", "Set up CI/CD at Acme", null, null, null)).rejects.toThrow(/kind_shape/)
    await expect(insert("skill_only", "Figma", "Figma", null, null)).rejects.toThrow(/text_key/)
    await expect(sql`update application set added_facts_confirmed_version = 1 where id = ${A.application}::uuid`.execute(admin)).rejects.toThrow(/confirmation_pair/)
  })

  it("the cause check accepts the two new causes after up", async () => {
    const blocked = await seedApplication(A.candidate)
    await sql`update application set state = 'documents_blocked', blocked_document = 'cover_letter', blocked_claim_cause = 'skill_only_in_bullet' where id = ${blocked}::uuid`.execute(admin)
    await sql`update application set blocked_claim_cause = 'added_fact_hedge' where id = ${blocked}::uuid`.execute(admin)
    await sql`delete from application where id = ${blocked}::uuid`.execute(admin)
  })

  it("down (development only): removes the table, the columns, the marker and the check's two causes; the second up succeeds and the old causes still hold", async () => {
    const down = await migrator().migrateDown()
    expect(down.error).toBeUndefined()
    expect((await sql`select 1 from migration_marker where name = ${ADDED_FACTS_MARKER}`.execute(admin)).rows).toEqual([])
    expect((await sql`select 1 from pg_tables where tablename = 'application_added_fact'`.execute(admin)).rows).toEqual([])
    const columns = (await sql<{ table_name: string; column_name: string }>`select table_name, column_name from information_schema.columns where table_schema = 'public' and column_name like 'added_facts%' order by 1, 2`.execute(admin)).rows
    expect(columns).toEqual([])
    const row = await seedApplication(A.candidate)
    await sql`update application set state = 'documents_blocked', blocked_document = 'cover_letter', blocked_claim_cause = 'contact_detail' where id = ${row}::uuid`.execute(admin)
    await expect(sql`update application set blocked_claim_cause = 'skill_only_in_bullet' where id = ${row}::uuid`.execute(admin)).rejects.toThrow(/blocked_claim_cause_check/)
    expect((await migrator().migrateToLatest()).error).toBeUndefined()
    expect((await sql`select 1 from migration_marker where name = ${ADDED_FACTS_MARKER}`.execute(admin)).rows).toHaveLength(1)
    expect((await sql`select 1 from pg_tables where tablename = 'application_added_fact'`.execute(admin)).rows).toHaveLength(1)
    await sql`update application set blocked_claim_cause = 'skill_only_in_bullet' where id = ${row}::uuid`.execute(admin)
    await sql`delete from application where id = ${row}::uuid`.execute(admin)
    // Applications are untouched by the round trip; the added-fact table is recreated empty.
    expect(await count(sql<{ n: number }>`select count(*)::int as n from application where id in (${A.application}::uuid, ${B.application}::uuid)`)).toBe(2)
    expect(await count(sql<{ n: number }>`select count(*)::int as n from application_added_fact`)).toBe(0)
  })

  // devops-config.r1.md "down" step 2 and the migration's own `down` say a row holding a new cause is cleared first.
  // `application` has forced row security and `down` runs as the owner with no Candidate bound, so that update touches
  // no row and the old 7-value check then fails on the remaining one. Development only (production has no down).
  it("the cause-clearing update `down` runs as the owner, unbound, touches no row of a forced-RLS table (the cause of BLOCKER[backend]-1)", async () => {
    const row = await seedApplication(A.candidate)
    await sql`update application set state = 'documents_blocked', blocked_document = 'cover_letter', blocked_claim_cause = 'added_fact_hedge' where id = ${row}::uuid`.execute(admin)
    const result = await sql`update application set blocked_claim_cause = null where blocked_claim_cause in ('skill_only_in_bullet', 'added_fact_hedge')`.execute(owner)
    expect(Number(result.numAffectedRows ?? 0)).toBe(0)
    await sql`delete from application where id = ${row}::uuid`.execute(admin)
  })

  it("down (development only): a row that holds a new cause does not stop the round trip (BLOCKER[backend], dev-only)", async () => {
    const row = await seedApplication(A.candidate)
    await sql`update application set state = 'documents_blocked', blocked_document = 'cover_letter', blocked_claim_cause = 'added_fact_hedge' where id = ${row}::uuid`.execute(admin)
    const down = await migrator().migrateDown()
    try {
      expect(down.error).toBeUndefined()
    } finally {
      // Leave the database at the latest migration for the runbook tests below, whatever happened.
      await sql`update application set blocked_claim_cause = null where id = ${row}::uuid`.execute(admin)
      if (down.error) await migrator().migrateDown().catch(() => undefined)
      expect((await migrator().migrateToLatest()).error).toBeUndefined()
      await sql`delete from application where id = ${row}::uuid`.execute(admin)
    }
  })
})

describe("QA FEAT-0017: Level 2 rollback runbook SQL and its five zero-counts (devops-config.r1.md)", () => {
  const counts = async () => ({
    deletedWithFacts: await count(sql<{ n: number }>`select count(*)::int as n from application_added_fact f join application a on a.id = f.application_id where a.details_deleted_at is not null`),
    deletedWithConfirmation: await count(sql<{ n: number }>`select count(*)::int as n from application where details_deleted_at is not null and (added_facts_confirmed_version is not null or added_facts_match is not null)`),
    confirmed: await count(sql<{ n: number }>`select count(*)::int as n from application where added_facts_confirmed_version is not null`),
    queuedWithFacts: await count(sql<{ n: number }>`select count(*)::int as n from application where submission_state = 'queued' and added_facts_version > 0`),
    newCauses: await count(sql<{ n: number }>`select count(*)::int as n from application where blocked_claim_cause in ('skill_only_in_bullet','added_fact_hedge')`),
  })

  it("seeds both Candidates with every residue the runbook names, and the five counts are non-zero before it runs", async () => {
    for (const side of [A, B]) {
      const queued = await seedApplication(side.candidate)
      await sql`update application set submission_state = 'queued', added_facts_version = 2 where id = ${queued}::uuid`.execute(admin)
      const confirmed = await seedApplication(side.candidate)
      await sql`update application set added_facts_version = 1, added_facts_confirmed_version = 1, added_facts_confirmed_at = now(), added_facts_match = '{"basis":"qa"}'::jsonb where id = ${confirmed}::uuid`.execute(admin)
      const blocked = await seedApplication(side.candidate)
      await sql`update application set state = 'documents_blocked', blocked_document = 'cover_letter', blocked_claim_cause = 'skill_only_in_bullet' where id = ${blocked}::uuid`.execute(admin)
      const deleted = await seedApplication(side.candidate)
      await seedFact(side.candidate, deleted, "Residue")
      await sql`update application set details_deleted_at = now(), final_status = 'details_deleted', added_facts_confirmed_version = 1, added_facts_confirmed_at = now(), added_facts_match = '{"basis":"qa"}'::jsonb where id = ${deleted}::uuid`.execute(admin)
      Object.assign(side, { queued, confirmed, blocked, deleted })
    }
    Object.assign(A, { queued: (A as Record<string, string>).queued, blocked: (A as Record<string, string>).blocked })
    const before = await counts()
    for (const value of Object.values(before)) expect(value).toBeGreaterThan(0)
  })

  it("running statements a to d once per Candidate, each in its own bound transaction, takes every count to zero and leaves live Applications and the schema in place", async () => {
    const candidates = (await sql<{ id: string }>`select id::text as id from candidate`.execute(admin)).rows.map((row) => row.id)
    expect(candidates).toEqual(expect.arrayContaining([A.candidate, B.candidate]))
    for (const id of candidates) {
      await bound(runtime, id, async (tx) => {
        await sql`delete from application_added_fact where application_id in (select id from application where details_deleted_at is not null)`.execute(tx)
        await sql`update application set added_facts_confirmed_version = null, added_facts_confirmed_at = null, added_facts_match = null where details_deleted_at is not null`.execute(tx)
        await sql`update application set added_facts_confirmed_version = null, added_facts_confirmed_at = null where added_facts_confirmed_version is not null`.execute(tx)
        await sql`update application set submission_state = null where submission_state = 'queued' and added_facts_version > 0`.execute(tx)
        await sql`update application set blocked_claim_cause = null where blocked_claim_cause in ('skill_only_in_bullet', 'added_fact_hedge')`.execute(tx)
      })
    }
    expect(await counts()).toEqual({ deletedWithFacts: 0, deletedWithConfirmation: 0, confirmed: 0, queuedWithFacts: 0, newCauses: 0 })
    // One Candidate's loop does not stand in for the other's (the runbook's reason for the loop): a run bound to A alone leaves B's residue.
    expect((await sql`select 1 from migration_marker where name = ${ADDED_FACTS_MARKER}`.execute(admin)).rows).toHaveLength(1)
    expect((await sql`select 1 from pg_tables where tablename = 'application_added_fact'`.execute(admin)).rows).toHaveLength(1)
  })

  it("a run bound to one Candidate alone reports success and skips the other (why the runbook loops)", async () => {
    const queued = await seedApplication(B.candidate)
    await sql`update application set submission_state = 'queued', added_facts_version = 3 where id = ${queued}::uuid`.execute(admin)
    await bound(runtime, A.candidate, (tx) => sql`update application set submission_state = null where submission_state = 'queued' and added_facts_version > 0`.execute(tx))
    expect(await counts()).toMatchObject({ queuedWithFacts: 1 })
    await bound(runtime, B.candidate, (tx) => sql`update application set submission_state = null where submission_state = 'queued' and added_facts_version > 0`.execute(tx))
    expect(await counts()).toMatchObject({ queuedWithFacts: 0 })
  })

  it("the cleared rows are the only change: the live queued rows of Applications with no added facts stay queued", async () => {
    const plain = await seedApplication(A.candidate)
    await sql`update application set submission_state = 'queued' where id = ${plain}::uuid`.execute(admin)
    await bound(runtime, A.candidate, (tx) => sql`update application set submission_state = null where submission_state = 'queued' and added_facts_version > 0`.execute(tx))
    expect((await sql<{ submission_state: string | null }>`select submission_state from application where id = ${plain}::uuid`.execute(admin)).rows).toEqual([{ submission_state: "queued" }])
  })
})
