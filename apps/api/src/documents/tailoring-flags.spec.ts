/**
 * EPIC-0012 Revision 2 addendum (A1 to A6, B, C, D): what the flags gate and what they must never
 * weaken. The hard fails run in every flag state; only the two allowances disappear when their flag is
 * off. Count-only monitoring is checked here at the helper level; the service log lines are asserted in
 * the integration spec.
 */
import { describe, expect, it } from "vitest"

import type { ModelGateway } from "../ai/model-gateway.js"
import type { SharedRuntimeConfig } from "../config/env.js"
import type { TenantDatabase } from "../db/tenant-database.js"
import { directionFrameWords } from "./company-direction.js"
import { directionParagraphCount, dropOrphanDirection, dropUnsupportedSentences, hardFailCounts, needsMeaningCheck, postingGuard, validateDocument } from "./document-claims.js"
import type { DocumentsRepository } from "./documents.repository.js"
import type { CandidateFiles } from "../files/candidate-files.js"
import type { Clock } from "../shared/clock.js"
import type { CoverLetterContent, DocumentLine, ResumeContent } from "./document-model.js"
import { meaningKey } from "./line-text.js"

const FACTS = new Map([
  ["WIND", "Built wind farm financial models for offshore projects, forecasting revenue and cost"],
  ["PAY", "Supported the payments migration"],
])

const POSTING = "Build models in Tableau. Carbon accounting matters. We will halve operational emissions by 2030. We seek a Sustainability Consultant."
const QUOTE = "We will halve operational emissions by 2030"
/** Flags off, as the service builds it: no posting terms and no direction quotes. */
const OFF_GUARD = postingGuard(POSTING, "Sustainability Consultant", ["carbon accounting"], false, [])
/** Direction on, bridges on. */
const ON_GUARD = postingGuard(POSTING, "Sustainability Consultant", ["carbon accounting"], true, [QUOTE])

const QUOTE_SENTENCE = "Your plan to “halve operational emissions by 2030” is clear."
const FACT_SENTENCE = "I built wind farm financial models for offshore projects, forecasting revenue and cost."
const TARGET = { employer: "Verdant Energy", roleTitle: "Sustainability Consultant" }

const summary = (text: string, factId = "WIND"): ResumeContent => ({ kind: "resume", summary: [{ text, factIds: [factId] }], experience: [], skills: [], education: [] })
const bullet = (text: string, factId = "WIND"): ResumeContent => ({
  kind: "resume",
  summary: [],
  experience: [{ heading: { text: "Built wind farm financial models", factIds: [factId] }, bullets: [{ text, factIds: [factId] }] }],
  skills: [],
  education: [],
})
const letter = (paragraphs: readonly string[], factId = "WIND"): CoverLetterContent => ({
  kind: "cover_letter",
  greeting: "Dear Hiring Team,",
  opening: null,
  paragraphs: paragraphs.map((text) => ({ text, factIds: [factId] })),
  closingLine: null,
  closing: "Kind regards,",
})
/** The verdict key a line's text gets with the facts it cites (R15): no verdict matches on text alone. */
const checked = (text: string, factId = "WIND"): Set<string> => new Set([meaningKey(text, [factId])])

describe("EPIC-0012 Revision 2 addendum, B: the service defaults", () => {
  it("DocumentsService built with no flag fields behaves off/off", async () => {
    const { DocumentsService } = await import("./documents.service.js")
    const service = new DocumentsService(
      {} as DocumentsRepository,
      {} as ModelGateway,
      {} as CandidateFiles,
      {} as Clock,
      {} as TenantDatabase,
      {} as SharedRuntimeConfig
    )
    expect((service as unknown as { flags: Readonly<{ bridges: boolean; direction: boolean }> }).flags).toEqual({ bridges: false, direction: false })
  })
})

describe("EPIC-0012 Revision 2 addendum, B: hard fails run with the flags off", () => {
  it("the off guard lends no posting terms and no direction", () => {
    expect(OFF_GUARD.text).toBe("")
    expect(OFF_GUARD.direction).toEqual([])
    // Gaps, role nouns and borrowed names are still built: they are hard fails in every state.
    expect(OFF_GUARD.gaps).toEqual(["carbon accounting"])
    expect(OFF_GUARD.roleNouns).toContain("consultant")
    expect(OFF_GUARD.names).toContain("tableau")
  })

  it("still hard-fails a role noun", () => {
    const text = "Built wind farm financial models for offshore projects as a sustainability consultant."
    expect(validateDocument(summary(text), FACTS, null, null, checked(text), OFF_GUARD)).toMatchObject({ ok: false, reason: "unsupported_claim", hardFail: "role_noun" })
    expect(needsMeaningCheck({ text, factIds: ["WIND"] }, FACTS, null, null, "summary", OFF_GUARD)).toBe(false)
  })

  it("still hard-fails a gap skill", () => {
    const text = "Built wind farm models with carbon accounting, forecasting revenue and cost."
    expect(validateDocument(summary(text), FACTS, null, null, checked(text), OFF_GUARD)).toMatchObject({ ok: false, reason: "unsupported_claim", hardFail: "gap" })
  })

  it("still hard-fails a borrowed name", () => {
    const text = "Built wind farm models in tableau, forecasting revenue and cost."
    expect(validateDocument(summary(text), FACTS, null, null, checked(text), OFF_GUARD)).toMatchObject({ ok: false, reason: "unsupported_claim", hardFail: "borrowed_name" })
  })

  it("still hard-fails support-role inflation", () => {
    const text = "Led the payments migration"
    expect(validateDocument(summary(text, "PAY"), FACTS, null, null, checked(text, "PAY"), OFF_GUARD)).toMatchObject({ ok: false, reason: "unsupported_claim", hardFail: "support_inflation" })
  })

  it("a completion word is only reachable through a stripped direction; with direction off the quote fails in code", () => {
    const text = `${QUOTE_SENTENCE} I met the target. ${FACT_SENTENCE}`
    const off = validateDocument(letter([text]), FACTS, TARGET, null, checked(text), OFF_GUARD)
    expect(off).toMatchObject({ ok: false, reason: "unsupported_claim" })
    if (!off.ok) expect(off.hardFail).not.toBe("completion_word")
    expect(validateDocument(letter([text]), FACTS, TARGET, null, checked(text), ON_GUARD)).toMatchObject({ ok: false, reason: "unsupported_claim", hardFail: "completion_word" })
  })

  it("with direction on, the same paragraph without a completion word is kept", () => {
    const text = `${QUOTE_SENTENCE} ${FACT_SENTENCE}`
    expect(validateDocument(letter([text]), FACTS, TARGET, null, checked(text), ON_GUARD)).toEqual({ ok: true })
  })

  it("bridges on: the 1f abuse lines still fail in code even when the judge says supported", () => {
    const abuses = [
      ["a role noun", "Built wind farm financial models as a sustainability consultant, forecasting revenue and cost."],
      ["a gap skill", "Built wind farm models with carbon accounting, forecasting revenue and cost."],
      ["an acronym name", "Built wind farm models in tableau, forecasting revenue and cost."],
      ["an acronym", "Built wind farm models for ESG reporting"],
      ["a title word", "Built senior wind farm models"],
      ["a scope verb", "Drove the payments migration"],
    ] as const
    for (const [, text] of abuses) {
      const factId = text.includes("payments") ? "PAY" : "WIND"
      expect(validateDocument(summary(text, factId), FACTS, null, null, checked(text, factId), ON_GUARD), text).toMatchObject({ ok: false, reason: "unsupported_claim" })
    }
  })

  it("bridges on: a supported field tag passes only when judged", () => {
    const text = "Built wind farm financial models for renewable energy, forecasting revenue and cost."
    const guard = postingGuard("Renewable energy developer. Build wind farm models for renewable energy projects.", "Energy Analyst", [], true, [])
    expect(validateDocument(summary(text), FACTS, null, null, new Set(), guard)).toMatchObject({ ok: false })
    expect(validateDocument(summary(text), FACTS, null, null, checked(text), guard)).toEqual({ ok: true })
  })
})

describe("EPIC-0012 Revision 2 addendum, A6: an orphan direction paragraph", () => {
  it("is dropped when the letter keeps another body paragraph", () => {
    const result = dropOrphanDirection(letter([QUOTE_SENTENCE, FACT_SENTENCE]), ON_GUARD)
    expect(result.dropped).toBe(1)
    expect(result.orphan).toBe(false)
    expect(result.letter.paragraphs.map((paragraph) => paragraph.text)).toEqual([FACT_SENTENCE])
  })

  it("is kept and counted as an orphan when it is the last body paragraph", () => {
    const result = dropOrphanDirection(letter([QUOTE_SENTENCE]), ON_GUARD)
    expect(result.dropped).toBe(0)
    expect(result.orphan).toBe(true)
    expect(result.letter.paragraphs.map((paragraph) => paragraph.text)).toEqual([QUOTE_SENTENCE])
  })

  it("does nothing when the direction flag is off, or the paragraph keeps another sentence", () => {
    expect(dropOrphanDirection(letter([QUOTE_SENTENCE]), OFF_GUARD)).toMatchObject({ dropped: 0, orphan: false })
    const mixed = dropOrphanDirection(letter([`${QUOTE_SENTENCE} ${FACT_SENTENCE}`, FACT_SENTENCE]), ON_GUARD)
    expect(mixed).toMatchObject({ dropped: 0, orphan: false })
  })

  it("counts the paragraphs that hold a direction sentence", () => {
    expect(directionParagraphCount(letter([QUOTE_SENTENCE, FACT_SENTENCE]), ON_GUARD)).toBe(1)
    expect(directionParagraphCount(letter([FACT_SENTENCE]), ON_GUARD)).toBe(0)
    expect(directionParagraphCount(letter([QUOTE_SENTENCE]), OFF_GUARD)).toBe(0)
  })

  it("a tie sentence with 'gives you data you can trust' never survives the repair", () => {
    const tie = "That goal gives you data you can trust."
    // No judge verdict for the paragraph: the quote sentence alone is not mechanical, so the paragraph
    // goes and the letter keeps its fact paragraph. The tie sentence can never be kept.
    const result = dropUnsupportedSentences(letter([`${QUOTE_SENTENCE} ${tie}`, FACT_SENTENCE]), FACTS, TARGET, null, new Set(), ON_GUARD)
    expect(result.dropped).toBe(1)
    expect(result.letter.paragraphs.map((paragraph) => paragraph.text)).toEqual([FACT_SENTENCE])
  })
})

describe("EPIC-0012 Revision 2, 2.3 and addendum C: hard-fail counts", () => {
  it("counts one reason per failing draft line, with no text", () => {
    const resume: ResumeContent = {
      ...bullet("Built wind farm models with carbon accounting.", "WIND"),
      summary: [{ text: "Built wind farm financial models as a sustainability consultant.", factIds: ["WIND"] }],
      experience: [
        {
          heading: { text: "Built wind farm financial models", factIds: ["WIND"] },
          bullets: [
            { text: "Built wind farm models with carbon accounting.", factIds: ["WIND"] },
            { text: "Built wind farm models in tableau.", factIds: ["WIND"] },
          ],
        },
      ],
    }
    const completion = `${QUOTE_SENTENCE} I met the target. ${FACT_SENTENCE}`
    const counts = hardFailCounts(resume, letter([completion]), FACTS, TARGET, null, ON_GUARD, FACTS)
    expect(counts).toEqual({ role_noun: 1, gap: 1, borrowed_name: 1, completion_word: 1 })
    // Counts only: the values can never hold a line, a fact or a posting word.
    for (const value of Object.values(counts)) expect(typeof value).toBe("number")
    expect(JSON.stringify(counts)).not.toMatch(/wind|tableau|carbon|2030/i)
  })

  it("is empty when every draft line passes or only needs the judge", () => {
    const resume = bullet("Built wind farm financial models for offshore projects, forecasting revenue and cost.")
    expect(hardFailCounts(resume, letter([FACT_SENTENCE]), FACTS, null, null, ON_GUARD, FACTS)).toEqual({})
  })

  it("counts a names_target letter line as a hard fail", () => {
    const counts = hardFailCounts(bullet(FACTS.get("WIND")!), letter(["Verdant Energy is a great place to build models."]), FACTS, TARGET, null, ON_GUARD, FACTS)
    expect(counts).toEqual({ names_target: 1 })
  })

  it("exposes the frame words the promptA4 list must stay inside", () => {
    expect([...directionFrameWords()]).toEqual(expect.arrayContaining(["your", "you", "plan", "clear"]))
  })
})

describe("EPIC-0012 Revision 2 addendum, D: a guard still checks the line shape", () => {
  it("the direction allowance is not offered in a resume summary", () => {
    const content: ResumeContent = { kind: "resume", summary: [{ text: QUOTE_SENTENCE, factIds: ["WIND"] }], experience: [], skills: [], education: [] }
    expect(validateDocument(content, FACTS, null, null, checked(QUOTE_SENTENCE), ON_GUARD)).toMatchObject({ ok: false })
  })

  it("a second direction sentence is never stripped", () => {
    const second = "Your next target to “halve operational emissions by 2030” is clear."
    const paragraphs = letter([`${QUOTE_SENTENCE} ${second}`])
    expect(validateDocument(paragraphs, FACTS, TARGET, null, checked(`${QUOTE_SENTENCE} ${second}`), ON_GUARD)).toMatchObject({ ok: false })
  })

  it("a letter paragraph is judged whole, as a paragraph, never as one resume line", () => {
    const line: DocumentLine = { text: "Built wind farm financial models for offshore projects, forecasting revenue and costs.", factIds: ["WIND"] }
    expect(needsMeaningCheck(line, FACTS, null, null, "letter_paragraph", ON_GUARD)).toBe(true)
  })
})
