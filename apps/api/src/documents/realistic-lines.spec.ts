import { describe, expect, it } from "vitest"

import type { CoverLetterContent } from "./document-model.js"
import { needsMeaningCheck, validateDocument } from "./document-claims.js"
import { meaningKey } from "./line-text.js"

/**
 * SEC-404 / CR4-01 false-block measurement on the realistic CV used by QA in
 * slice 4 (.runs/slice-04/qa-e2e/fixtures.mts realCvReply, run4.mts
 * "realistic" and "r4" natural lines). Facts carry their section heading, as
 * documents.service.ts builds them. Lines the new rules block are listed in
 * KNOWN_FALSE_BLOCKS and reported; every other line must pass.
 */
const PAYSTACK = "Staff Software Engineer, Paystack-like Payments Ltd, Jun 2021 – Present"
const KOBO = "Senior Backend Engineer, Kobo Logistics, Mar 2018 – May 2021"
const FACTS = new Map([
  ["SUM", "Full-stack engineer with 9 years of experience in TypeScript, Go and PostgreSQL. Summary"],
  ["M14", `Led the migration of 14 services from Heroku to AWS ECS, cutting hosting costs by 31%. ${PAYSTACK}`],
  ["WH", `Designed an idempotent webhook pipeline handling about 2.5 million events per day. ${PAYSTACK}`],
  ["MEN", `Mentored 6 engineers, 3 of whom were promoted to senior within 18 months. ${PAYSTACK}`],
  ["ROUTE", `Built route-optimisation APIs in Go serving 40,000 daily deliveries across 5 cities. ${KOBO}`],
  ["P95", `Reduced p95 latency from 820 ms to 190 ms with Redis caching and query tuning. ${KOBO}`],
  ["SHIP", "Shipped React and Node.js features for US fintech clients. Software Engineer, Andela, 2015–2018"],
  ["BENG", "BEng Electrical Engineering, Second Class Upper. BEng Electrical Engineering, Obafemi Awolowo University, 2010–2015"],
  ["SK", "TypeScript, Go, Node.js, React, PostgreSQL, Redis, Kafka. Skills"],
  ["TF", "AWS (ECS, Lambda) and Terraform. Skills"],
  ["AWS", "AWS Certified Solutions Architect – Associate, 2022. Certifications"],
])

const LINES: ReadonlyArray<readonly [string, string]> = [
  // run4.mts "realistic" resume lines
  ["Full-stack engineer with 9 years of experience in TypeScript, Go and PostgreSQL", "SUM"],
  ["AWS Certified Solutions Architect – Associate, 2022", "AWS"],
  [PAYSTACK, "M14"],
  ["Led the migration of 14 services from Heroku to AWS ECS, cutting hosting costs by 31%", "M14"],
  ["Designed an idempotent webhook pipeline that handles about 2.5 million events per day", "WH"],
  ["Mentored 6 engineers; 3 were promoted to senior within 18 months", "MEN"],
  [KOBO, "ROUTE"],
  ["Built route-optimisation APIs in Go that serve 40,000 daily deliveries across 5 cities", "ROUTE"],
  ["Reduced p95 latency from 820 ms to 190 ms through Redis caching and query tuning", "P95"],
  ["Software Engineer, Andela, 2015–2018", "SHIP"],
  ["Shipped React and Node.js features for US fintech clients", "SHIP"],
  ["TypeScript, Go, Node.js, React, PostgreSQL, Redis, Kafka", "SK"],
  ["AWS (ECS, Lambda) and Terraform", "TF"],
  ["BEng Electrical Engineering, Obafemi Awolowo University, 2010–2015, Second Class Upper", "BENG"],
  // run4.mts letter body lines
  ["At Paystack-like Payments Ltd I led the migration of 14 services from Heroku to AWS ECS, which cut hosting costs by 31%.", "M14"],
  ["I also mentored 6 engineers, and 3 of them were promoted to senior within 18 months.", "MEN"],
  ["Before that, at Kobo Logistics, I built route-optimisation APIs in Go serving 40,000 daily deliveries across 5 cities.", "ROUTE"],
  ["I reduced p95 latency from 820 ms to 190 ms with Redis caching and query tuning.", "P95"],
  // run4.mts "r4" natural lines (F-QA4-07)
  ["My strongest work has been in payments infrastructure, where I led the migration of 14 services from Heroku to AWS ECS.", "M14"],
  ["I care about reliability: I designed an idempotent webhook pipeline handling about 2.5 million events per day.", "WH"],
  ["Mentoring matters to me; I mentored 6 engineers and 3 were promoted to senior within 18 months.", "MEN"],
  ["I enjoy hard performance problems, and I cut p95 latency from 820 ms to 190 ms with Redis caching and query tuning.", "P95"],
  ["Earlier, I shipped React and Node.js features for US fintech clients.", "SHIP"],
  ["I work across TypeScript, Go, Node.js, React, PostgreSQL, Redis and Kafka.", "SK"],
  ["I hold a BEng in Electrical Engineering, Second Class Upper.", "BENG"],
  ["I am an AWS Certified Solutions Architect – Associate (2022).", "AWS"],
  // document-claims.spec F-QA4-07 wider openers
  ["Recently, I led the migration of 14 services from Heroku to AWS ECS.", "M14"],
  ["Notably, I reduced p95 latency from 820 ms to 190 ms.", "P95"],
  ["Ultimately, 3 of the 6 engineers I mentored were promoted to senior.", "MEN"],
  ["Our webhook pipeline handled about 2.5 million events per day.", "WH"],
  ["During that time I mentored 6 engineers.", "MEN"],
]

/** Measured false blocks under the new rules (reported in the backend report, not hidden). */
const KNOWN_FALSE_BLOCKS: ReadonlySet<string> = new Set<string>([])

function letter(text: string, factIds: string[]): CoverLetterContent {
  return { kind: "cover_letter", greeting: "Dear Hiring Team,", opening: null, paragraphs: [{ text, factIds }], closingLine: null, closing: "Kind regards," }
}

describe("realistic CV lines under SEC-404 and CR4-01 (false-block measurement)", () => {
  it.each(LINES.filter(([text]) => !KNOWN_FALSE_BLOCKS.has(text)))("passes when judged: %s", (text, factId) => {
    // Revision 2, 2.1: a reworded line reaches the meaning check; the judge's supported: true releases it.
    const judged: ReadonlySet<string> = needsMeaningCheck({ text, factIds: [factId] }, FACTS, null, null, "letter_paragraph") ? new Set([meaningKey(text, [factId])]) : new Set()
    expect(validateDocument(letter(text, [factId]), FACTS, null, null, judged)).toEqual({ ok: true })
  })

  it("the measured false-block list is empty", () => {
    expect([...KNOWN_FALSE_BLOCKS]).toEqual([])
  })
})
