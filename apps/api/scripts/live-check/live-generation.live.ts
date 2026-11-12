/**
 * EPIC-0012 live check. Runs the REAL DocumentsService.generate (prompt builder, schema, claim guard, repair,
 * meaning check, headline, keyword density, letter cap, render checks) against the REAL Anthropic model, on
 * synthetic fixtures, with no database. Only the persistence ports are faked, and the gateway's approval,
 * ledger and metering are replaced by call counters; the model client, the model choice per tier and the
 * schema re-check are the production ones.
 *
 * Run (key is read from the environment, never printed):
 *   set -a; . /path/to/.env; set +a
 *   LIVE_FIXTURES=f1,f2 LIVE_OUT=/some/dir pnpm --filter api exec vitest run -c vitest.live.config.ts
 * Hard limits across invocations are kept in $LIVE_OUT/counters.json: 12 runs, 40 model calls.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { Logger } from "@nestjs/common"
import { describe, expect, it } from "vitest"

import { MastraModelClient } from "../../src/ai/mastra-model-client.js"
import { INVALID_OUTPUT } from "../../src/ai/model-client.js"
import { containsKeyword, normaliseForAts, atsKeywords } from "../../src/ats/ats-score.js"
import { CandidateScope } from "../../src/db/candidate-scope.js"
import { DEFAULT_DOCUMENTS_MODEL } from "../../src/config/env.js"
import { verifyForwardStatements } from "../../src/discovery/posting-extraction.js"
import { DocumentsService } from "../../src/documents/documents.service.js"
import { sentencesOf } from "../../src/documents/company-direction.js"
import { postingGuard, postingTerms, validateDocument, type PostingGuard } from "../../src/documents/document-claims.js"
import type { DocumentContent, DocumentLine } from "../../src/documents/document-model.js"
import { FIXTURES, type Fixture } from "./fixtures.js"

const MAX_RUNS = 12
const MAX_CALLS = 40
const OUT = process.env.LIVE_OUT ?? ""
const CANDIDATE = "11111111-1111-4111-8111-111111111111"
const PROFILE_VERSION = 1

type Counters = { runs: number; calls: number; inputTokens: number; outputTokens: number; log: Array<{ run: string; purpose: string; model: string; input: number | null; output: number | null }> }
const countersPath = () => join(OUT, "counters.json")
const readCounters = (): Counters => (existsSync(countersPath()) ? JSON.parse(readFileSync(countersPath(), "utf8")) : { runs: 0, calls: 0, inputTokens: 0, outputTokens: 0, log: [] })
const writeCounters = (c: Counters) => writeFileSync(countersPath(), JSON.stringify(c, null, 2))

class LimitReached extends Error {}
class AuthFailure extends Error {}

describe("EPIC-0012 live generation check", () => {
  const wanted = (process.env.LIVE_FIXTURES ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  for (const entry of wanted) {
    const [key, repeat] = entry.split(":")
    const fixture = FIXTURES.find((f) => f.label.startsWith(`${key}-`))
    it(`${entry}`, async () => {
      expect(OUT).not.toBe("")
      expect(fixture).toBeDefined()
      mkdirSync(OUT, { recursive: true })
      const apiKey = process.env.ANTHROPIC_API_KEY
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing: stop and report")
      const counters = readCounters()
      if (counters.runs >= MAX_RUNS) throw new LimitReached("run limit")
      counters.runs += 1
      writeCounters(counters)
      const runLabel = `${fixture!.label}${repeat ? `-r${repeat}` : ""}`
      const result = await runFixture(fixture!, runLabel, apiKey)
      writeFileSync(join(OUT, `${runLabel}.json`), JSON.stringify(result, null, 2))
    })
  }
})

async function runFixture(fixture: Fixture, runLabel: string, apiKey: string) {
  const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-5-5"
  const documentsModel = process.env.ANTHROPIC_DOCUMENTS_MODEL ?? DEFAULT_DOCUMENTS_MODEL
  const client = new MastraModelClient()
  const calls: Array<{ purpose: string; model: string; input: number | null; output: number | null; prompt: string; raw: unknown; ok: boolean }> = []

  const gateway = {
    async generateObject(request: any) {
      const c = readCounters()
      if (c.calls >= MAX_CALLS) throw new LimitReached("call limit")
      c.calls += 1
      writeCounters(c)
      const useModel = request.tier === "documents" && documentsModel !== model ? documentsModel : model
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), request.timeoutMs)
      try {
        const out = await client.generateObject({
          apiKey,
          model: useModel,
          system: request.system,
          prompt: request.prompt,
          schema: request.schema,
          maxOutputTokens: request.maxOutputTokens,
          ...(request.effort !== undefined && { effort: request.effort }),
          abortSignal: abort.signal,
        })
        const fresh = readCounters()
        fresh.inputTokens += out.usage.inputTokens ?? 0
        fresh.outputTokens += out.usage.outputTokens ?? 0
        fresh.log.push({ run: runLabel, purpose: request.purpose, model: useModel, input: out.usage.inputTokens, output: out.usage.outputTokens })
        writeCounters(fresh)
        const parsed = out.object === INVALID_OUTPUT ? undefined : request.schema.safeParse(out.object)
        const ok = parsed?.success === true
        calls.push({ purpose: request.purpose, model: useModel, input: out.usage.inputTokens, output: out.usage.outputTokens, prompt: request.prompt, raw: out.object === INVALID_OUTPUT ? "INVALID_OUTPUT" : out.object, ok })
        return ok ? { ok: true, object: parsed!.data } : { ok: false, failure: "invalid_output" }
      } catch (error) {
        // Never print the message: it may quote the request. Classify the status only.
        const text = error instanceof Error ? `${error.name} ${error.message}` : ""
        if (/401|403|authentication|invalid x-api-key|permission/i.test(text)) throw new AuthFailure("auth error")
        calls.push({ purpose: request.purpose, model: useModel, input: null, output: null, prompt: request.prompt, raw: `provider_error:${error instanceof Error ? error.name : "unknown"}`, ok: false })
        return { ok: false, failure: "provider_error" }
      } finally {
        clearTimeout(timer)
      }
    },
  }

  const events: Array<Record<string, unknown>> = []
  Logger.overrideLogger({
    log: (m: unknown) => { try { events.push(JSON.parse(String(m))) } catch { events.push({ message: String(m) }) } },
    warn: (m: unknown) => events.push({ warn: String(m) }),
    error: (m: unknown) => events.push({ error: String(m) }),
  })

  const forward = verifyForwardStatements([...fixture.forwardStatements], fixture.postingText)
  const application = { id: "app-1", job_posting_id: "post-1", role_title: fixture.roleTitle, company: fixture.company }
  const posting = {
    posting_text: fixture.postingText,
    technologies: fixture.keywords.slice(0, Math.ceil(fixture.keywords.length / 2)),
    ats_skills: fixture.keywords.slice(Math.ceil(fixture.keywords.length / 2)),
    forward_statements: forward.length > 0 ? forward : null,
  }
  let stored: any[] = []
  let blocked: { kind: string; claim: string } | null = null
  let failed: string | null = null
  const repository = {
    findApplication: async () => application,
    approvedProfile: async () => ({ version: PROFILE_VERSION, sections: fixture.sections }),
    findPosting: async () => posting,
    readContact: async () => ({ full_name: "Jordan Testwell", lines: [] }),
    markFailed: async (_id: string, reason: string) => { failed = reason; return undefined },
    markPaused: async () => undefined,
    markBlocked: async (_id: string, _v: number, kind: string, claim: string) => { blocked = { kind, claim }; return [] },
    recordDocuments: async (_id: string, _v: number, docs: any[]) => { stored = docs; return { recorded: true, remove: [] } },
    requeueAtsHeld: async () => undefined,
  }
  const files = { write: async () => undefined, remove: async () => undefined }
  const service = new DocumentsService(repository as any, gateway as any, files as any, { now: () => new Date() } as any, {} as any)

  const outcome = await CandidateScope.run(CANDIDATE, () => service.generate("app-1"))
  Logger.overrideLogger(false)

  // ---- analysis -------------------------------------------------------------------------------------------------
  const keywords = atsKeywords(posting.technologies, posting.ats_skills, fixture.company)
  const facts = new Map<string, string>()
  const wording = new Map<string, string>()
  const aliasToReal = new Map<string, string>()
  let n = 1
  for (const s of fixture.sections) {
    const heading = [s.title, s.organization, s.period].filter(Boolean).join(", ")
    for (const f of s.facts) {
      aliasToReal.set(`F${n++}`, f.id)
      facts.set(f.id, heading === "" ? f.text : `${f.text}. ${heading}`)
      wording.set(f.id, f.text)
    }
  }
  const factText = (id: string) => wording.get(id) ?? "?"
  const genCall = calls.find((c) => c.purpose === "tailored_documents")
  const meaningCall = calls.find((c) => c.purpose === "document_meaning_check")
  const raw = genCall?.raw as any
  const real = (ids: string[]) => ids.map((id) => aliasToReal.get(id) ?? id)

  const profileText = fixture.sections.flatMap((s) => [s.title, ...s.facts.map((f) => f.text)]).join("\n")
  const normalisedProfile = normaliseForAts(profileText)
  const guard: PostingGuard = postingGuard(
    fixture.postingText,
    fixture.roleTitle,
    keywords.filter(({ keyword }) => !containsKeyword(normalisedProfile, keyword)).map(({ keyword }) => keyword),
    keywords.length > 0,
    forward
  )
  // Which draft lines did the meaning check mark supported?
  const supportedByMeaning = new Set<string>()
  if (meaningCall && meaningCall.ok) {
    const items = [...String(meaningCall.prompt).matchAll(/<item id="(\d+)">\n<line>([\s\S]*?)<\/line>/g)]
    const results = ((meaningCall.raw as any)?.results ?? []) as Array<{ id: number; supported: boolean }>
    for (const r of results) if (r.supported) { const hit = items.find((m) => Number(m[1]) === r.id); if (hit) supportedByMeaning.add(hit[2]!.replace(/‹/g, "<").replace(/›/g, ">")) }
  }
  const reasonFor = (line: DocumentLine, section: "summary" | "bullet" | "skills" | "letter"): string => {
    const content: DocumentContent =
      section === "letter"
        ? { kind: "cover_letter", greeting: "", opening: null, paragraphs: [line], closingLine: null, closing: "" }
        : { kind: "resume", summary: section === "summary" ? [line] : [], experience: section === "bullet" ? [{ heading: { text: "", factIds: [] }, bullets: [line] }] : [], skills: section === "skills" ? [line] : [], education: [] }
    const strict = validateDocument(content, facts, section === "letter" ? { employer: fixture.company, roleTitle: fixture.roleTitle } : null, { name: "Jordan Testwell", lines: [] }, new Set(), guard)
    const judged = validateDocument(content, facts, section === "letter" ? { employer: fixture.company, roleTitle: fixture.roleTitle } : null, { name: "Jordan Testwell", lines: [] }, supportedByMeaning, guard)
    if (strict.ok) return "passes the word check"
    const base = `${strict.reason}: ${strict.unsupported.join(", ") || "-"}`
    return judged.ok ? `${base} -> accepted after meaning check supported:true` : base
  }

  const rawResume = raw?.resume
  const rawLetter = raw?.coverLetter
  const draftLines: Array<{ where: string; kind: "summary" | "bullet" | "skills" | "letter"; text: string; facts: string[]; factIds: string[] }> = []
  const addDraft = (where: string, kind: any, l: any) => draftLines.push({ where, kind, text: l.text, factIds: real(l.factIds), facts: real(l.factIds).map(factText) })
  rawResume?.summary?.forEach((l: any, i: number) => addDraft(`summary[${i}]`, "summary", l))
  rawResume?.experience?.forEach((e: any, i: number) => e.bullets.forEach((l: any, j: number) => addDraft(`experience[${i}].bullet[${j}]`, "bullet", l)))
  rawResume?.skills?.forEach((l: any, i: number) => addDraft(`skills[${i}]`, "skills", l))
  rawLetter?.paragraphs?.forEach((l: any, i: number) => addDraft(`letter.p[${i}]`, "letter", l))

  const content = Object.fromEntries(stored.map((d) => [d.kind, d.content])) as Record<string, any>
  const finalResume = content["resume"]
  const finalLetter = content["cover_letter"]
  const finalResumeTexts: string[] = finalResume ? [...finalResume.summary, ...finalResume.experience.flatMap((e: any) => e.bullets), ...finalResume.skills].map((l: DocumentLine) => l.text) : []
  const finalLetterTexts: string[] = finalLetter ? finalLetter.paragraphs.map((l: DocumentLine) => l.text) : []

  const lineOutcomes = draftLines.map((d) => {
    const pool = d.kind === "letter" ? finalLetterTexts : finalResumeTexts
    const kept = pool.includes(d.text)
    const reason = reasonFor({ text: d.text, factIds: d.factIds }, d.kind)
    const bridges = postingTerms({ text: d.text, factIds: d.factIds }, facts, guard)
    let fate = kept ? "kept as written" : "changed or dropped"
    if (!kept && d.kind === "letter") {
      const survivors = sentencesOf(d.text).filter((s) => finalLetterTexts.some((t) => t.includes(s)))
      fate = survivors.length > 0 ? `trimmed to ${survivors.length}/${sentencesOf(d.text).length} sentences` : "paragraph dropped"
    }
    if (!kept && d.kind !== "letter") {
      const same = finalResumeTexts.find((t) => d.factIds.some((id) => wording.get(id) === t))
      fate = same ? `replaced by fact wording` : "dropped or trimmed"
    }
    return { where: d.where, text: d.text, cites: d.facts, fate, reason, postingWords: bridges }
  })

  const countIn = (text: string, keyword: string) => {
    const kw = normaliseForAts(keyword)
    if (!kw) return 0
    return (normaliseForAts(text).match(new RegExp(`(^| )${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?= |$)`, "g")) ?? []).length
  }
  const kwCounts = keywords.map(({ keyword }) => ({
    keyword,
    inProfile: containsKeyword(normalisedProfile, keyword),
    draftResume: draftLines.filter((d) => d.kind !== "letter").reduce((s, d) => s + countIn(d.text, keyword), 0),
    draftResumeLines: draftLines.filter((d) => d.kind !== "letter" && d.kind !== "skills" && containsKeyword(normaliseForAts(d.text), keyword)).length,
    finalResume: finalResumeTexts.reduce((s, t) => s + countIn(t, keyword), 0),
    draftLetter: draftLines.filter((d) => d.kind === "letter").reduce((s, d) => s + countIn(d.text, keyword), 0),
    finalLetter: finalLetterTexts.reduce((s, t) => s + countIn(t, keyword), 0),
  }))

  const quotes = forward
  const directionSentences = finalLetterTexts.flatMap((t) => sentencesOf(t)).filter((s) => /["“”]/.test(s)).map((s) => {
    const spans = [...s.matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1]!)
    return { sentence: s, spans, exactFromQuote: spans.map((sp) => quotes.some((q) => q.includes(sp))), firstPerson: /\b(I|we|our|us|my|me)\b/i.test(s.replace(/["“][^"”]+["”]/g, "")) }
  })
  const rawDirection = draftLines.filter((d) => d.kind === "letter").flatMap((d) => sentencesOf(d.text)).filter((s) => /["“”]/.test(s))

  return {
    runLabel, fixture: fixture.label, note: fixture.note, outcome, blocked, failed,
    models: { default: model, documents: documentsModel },
    calls: calls.map((c) => ({ purpose: c.purpose, model: c.model, input: c.input, output: c.output, ok: c.ok })),
    events, forwardStatements: forward, keywordList: keywords.map((k) => k.keyword),
    gapKeywords: kwCounts.filter((k) => !k.inProfile).map((k) => k.keyword),
    headline: finalResume ? finalResume.headline ?? null : null,
    atsRecorded: finalResume?.ats ?? null,
    keywordCounts: kwCounts,
    lineOutcomes, rawDirectionSentences: rawDirection, finalDirectionSentences: directionSentences,
    meaningCheck: meaningCall ? { prompt: meaningCall.prompt, raw: meaningCall.raw } : null,
    finalResume: finalResume ? { headline: finalResume.headline ?? null, summary: finalResume.summary.map((l: DocumentLine) => l.text), experience: finalResume.experience.map((e: any) => ({ role: e.role ?? null, bullets: e.bullets.map((l: DocumentLine) => l.text) })), skills: finalResume.skills.map((l: DocumentLine) => l.text), education: finalResume.education.map((l: DocumentLine) => l.text) } : null,
    finalLetter: finalLetter ? { opening: finalLetter.opening, paragraphs: finalLetterTexts, closingLine: finalLetter.closingLine } : null,
    rawDraft: raw ?? null,
    facts: fixture.sections.map((s) => ({ title: s.title, organization: s.organization, period: s.period, facts: s.facts.map((f) => f.text) })),
  }
}
