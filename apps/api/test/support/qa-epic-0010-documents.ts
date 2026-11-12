import { applicationDetailSchema, createApplicationResponseSchema, pasteJobLinkResponseSchema } from "@eve/contracts"
import JSZip from "jszip"

import { DocumentsService } from "../../src/documents/documents.service.js"
import { extractPdfText } from "../../src/documents/render.js"
import { COMPANY, type PasteStack, STRONG_EXTRACTION, TITLE, decide, descPaystack } from "./qa-epic-0010.js"

/**
 * QA test authoring, step [5e], EPIC-0010: shared helpers for the document-generation scenarios
 * (pasted-description-documents.feature, pasted-description-safety.feature, manual-only.feature).
 * QA-owned. Documents are generated through the real route (`POST /v1/applications/{id}/documents/generate`),
 * with the model answered by FakeAnthropic.
 */

/** Career Profile facts with ids F1 to F4, the same ids the evaluation stub cites and the aliases the generation model sees. */
export const DOC_SECTIONS = [
  {
    id: "s1",
    kind: "experience",
    title: "Senior Frontend Engineer",
    organization: "Brightwave Ltd",
    period: "2021-2026",
    sourceQuote: null,
    facts: [
      { id: "F1", text: "Built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd", sourceQuote: null },
      { id: "F2", text: "Senior Frontend Engineer at Brightwave Ltd, 2021-2026", sourceQuote: null },
      { id: "F3", text: "Mentored 6 junior developers", sourceQuote: null },
      { id: "F4", text: "Cut release cycle from 2 weeks to 3 days", sourceQuote: null },
    ],
  },
]

/** A well-formed, truthful model answer: every line cites a fact. */
export const GOOD_DOCUMENTS = {
  resume: {
    summary: [{ text: "Senior Frontend Engineer who builds products from scratch to production.", factIds: ["F1", "F2"] }],
    experience: [
      {
        heading: { text: "Senior Frontend Engineer, Brightwave Ltd, 2021-2026", factIds: ["F2"] },
        bullets: [
          { text: "Built a React and TypeScript merchant dashboard from scratch to production.", factIds: ["F1"] },
          { text: "Cut the release cycle from 2 weeks to 3 days.", factIds: ["F4"] },
          { text: "Mentored 6 junior developers.", factIds: ["F3"] },
        ],
      },
    ],
    skills: [{ text: "React, TypeScript", factIds: ["F1"] }],
    education: [],
  },
  coverLetter: {
    paragraphs: [
      { text: "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd.", factIds: ["F1"] },
      { text: "I cut our release cycle from 2 weeks to 3 days and mentored 6 junior developers.", factIds: ["F3", "F4"] },
    ],
  },
} as const

/** Gives the Operator the UUID-fact Career Profile (approved) and a contact header. Run once after the stack boots. */
export async function installDocumentProfile(s: PasteStack): Promise<void> {
  await s.database.db.deleteFrom("career_profile_version").where("candidate_id", "=", s.database.operatorId).execute()
  await s.database.db
    .insertInto("career_profile_version")
    .values({ candidate_id: s.database.operatorId, version: 1, status: "approved", source: "edit", resume_upload_id: null, sections: JSON.stringify(DOC_SECTIONS), created_at: new Date(), approved_at: new Date() })
    .execute()
  await s.database.db.updateTable("candidate_contact").set({ full_name: "Ada Okafor", lines: JSON.stringify(["Lagos, Nigeria", "ada@example.com", "+234 800 000 0000"]) }).execute()
}

export type PastedSeed = Readonly<{
  marker: string
  description?: string
  title?: string
  company?: string
  technologies?: readonly string[]
  skills?: readonly string[]
  status?: Parameters<typeof decide>[3]
}>

/** Ada's pasted-description posting, evaluated by the stub then set to `status` (default ranked) with the given keywords. */
export async function pastedPosting(s: PasteStack, seed: PastedSeed): Promise<string> {
  for (let i = 0; i < 6; i += 1) s.anthropic.replyWithObject(STRONG_EXTRACTION)
  const response = await s.paste(s.ada, { description: seed.description ?? descPaystack(seed.marker), title: seed.title ?? TITLE, company: seed.company ?? COMPANY })
  if (response.status !== 201) throw new Error(`paste failed: ${response.status} ${JSON.stringify(response.body)}`)
  const id = pasteJobLinkResponseSchema.parse(response.body).posting.id
  // The evaluation consumed what it needed; later model requests in a test are scripted by the test.
  s.anthropic.reset()
  await decide(s.database.db, s.database.operatorId, id, seed.status ?? "ranked")
  const asStored = (names: readonly string[]) => JSON.stringify(names.map((name) => ({ name, quote: name })))
  if (seed.technologies) await s.database.db.updateTable("job_posting").set({ technologies: asStored(seed.technologies) }).where("id", "=", id).execute()
  if (seed.skills) await s.database.db.updateTable("job_posting").set({ ats_skills: asStored(seed.skills) }).where("id", "=", id).execute()
  return id
}

export async function createApplicationFor(s: PasteStack, jobPostingId: string): Promise<string> {
  const response = await s.ada.post("/v1/applications").send({ jobPostingId })
  if (response.status !== 201) throw new Error(`create failed: ${response.status} ${JSON.stringify(response.body)}`)
  return createApplicationResponseSchema.parse(response.body).application.id
}

/** Starts generation through the real route, waits for it, and returns the Application detail. */
export async function generateDocuments(s: PasteStack, applicationId: string) {
  await s.ada.post(`/v1/applications/${applicationId}/documents/generate`).expect(202)
  await s.app.get(DocumentsService).settled()
  return applicationDetailSchema.parse((await s.ada.get(`/v1/applications/${applicationId}`).expect(200)).body)
}

async function download(s: PasteStack, url: string): Promise<Buffer> {
  const response = await s.ada
    .get(url)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () => done(null, Buffer.concat(chunks)))
    })
    .expect(200)
  return response.body as Buffer
}

/** Every text a Candidate can read from the Application's documents: preview, stored content, PDF text and DOCX text. */
export async function allDocumentText(s: PasteStack, detail: ReturnType<typeof applicationDetailSchema.parse>): Promise<{ kind: string; preview: string; pdf: string; docx: string }[]> {
  const out: { kind: string; preview: string; pdf: string; docx: string }[] = []
  for (const document of detail.documents) {
    const pdf = await extractPdfText(await download(s, document.pdfUrl))
    const zip = await JSZip.loadAsync(await download(s, document.docxUrl))
    const docx = await zip.file("word/document.xml")!.async("string")
    out.push({ kind: document.kind, preview: document.previewText.join("\n"), pdf, docx })
  }
  return out
}

export const joinedText = (texts: readonly { preview: string; pdf: string; docx: string }[]): string => texts.map((text) => `${text.preview}\n${text.pdf}\n${text.docx}`).join("\n")
