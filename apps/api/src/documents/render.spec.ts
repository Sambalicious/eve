import { describe, expect, it } from "vitest"

import { type ContactHeader, type CoverLetterContent, type ResumeContent, plainTextOf } from "./document-model.js"
import { extractPdfText, renderDocx, renderPdf, splitWordsInContent, verifyPdfText, wordIntegrity } from "./render.js"

const CONTACT: ContactHeader = { name: "Ada Okafor", lines: ["Lagos, Nigeria", "ada@example.com"] }

const RESUME: ResumeContent = {
  kind: "resume",
  summary: [{ text: "Senior Frontend Engineer who builds products from scratch to production.", factIds: ["F1", "F2"] }],
  experience: [
    {
      heading: { text: "Senior Frontend Engineer, Brightwave Ltd, 2021–2024", factIds: ["F2"] },
      bullets: [
        { text: "Built a React and TypeScript merchant dashboard from scratch to production.", factIds: ["F1"] },
        { text: "Cut the release cycle from 2 weeks to 3 days.", factIds: ["F4"] },
        { text: "Mentored 6 junior developers.", factIds: ["F3"] },
      ],
    },
  ],
  skills: [{ text: "React, TypeScript", factIds: ["F1"] }],
  education: [{ text: "BSc Computer Science, University of Lagos, 2016", factIds: ["F5"] }],
}

const LETTER: CoverLetterContent = {
  kind: "cover_letter",
  greeting: "Dear Hiring Team at Acme Payments,",
  opening: "I am applying for the Senior Frontend Engineer role at Acme Payments.",
  closingLine: "I would welcome the chance to discuss how I can contribute to Acme Payments.",
  paragraphs: [
    { text: "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd.", factIds: ["F1"] },
    { text: "I cut our release cycle from 2 weeks to 3 days and mentored 6 junior developers.", factIds: ["F3", "F4"] },
  ],
  closing: "Kind regards,",
}

describe("PDF rendering (AC 5.2)", () => {
  it.each([
    ["resume", RESUME],
    ["cover letter", LETTER],
  ] as const)("the %s PDF has selectable text that matches the source, in order", async (_name, content) => {
    const pdf = await renderPdf(content, CONTACT)
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-")
    const text = await extractPdfText(pdf)
    for (const line of plainTextOf(content, CONTACT)) expect(text).toContain(line.replace(/\s+/g, " "))
    expect(await verifyPdfText(pdf, content, CONTACT)).toEqual({ ok: true })
  })

  it("the resume uses the owner's section titles in order: summary, experience, education, skills", async () => {
    const text = await extractPdfText(await renderPdf(RESUME, CONTACT))
    const positions = ["SUMMARY", "PROFESSIONAL EXPERIENCE", "EDUCATION", "SKILLS"].map((heading) => text.indexOf(heading))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it("prints the backend headline under the contact lines, before the sections", async () => {
    const headlined: ResumeContent = { ...RESUME, headline: "Senior Frontend Engineer" }
    const pdf = await renderPdf(headlined, CONTACT)
    expect(await verifyPdfText(pdf, headlined, CONTACT)).toEqual({ ok: true })
    expect(wordIntegrity(await renderPdf(headlined, CONTACT, { compress: false }), headlined, CONTACT)).toEqual({ ok: true })
    const text = await extractPdfText(pdf)
    const at = text.indexOf("Senior Frontend Engineer")
    expect(at).toBeGreaterThan(text.indexOf("ada@example.com"))
    expect(at).toBeLessThan(text.indexOf("SUMMARY"))
  })

  it("a resume without a headline renders exactly as before", async () => {
    const without: ResumeContent = { ...RESUME, headline: null }
    expect(await extractPdfText(await renderPdf(without, CONTACT))).toBe(await extractPdfText(await renderPdf(RESUME, CONTACT)))
    expect(plainTextOf(without, CONTACT)).toEqual(plainTextOf(RESUME, CONTACT))
    expect(await verifyPdfText(await renderPdf(without, CONTACT), without, CONTACT)).toEqual({ ok: true })
  })

  it("verification fails when the PDF does not contain the source text", async () => {
    const pdf = await renderPdf(RESUME, CONTACT)
    const other: ResumeContent = { ...RESUME, skills: [{ text: "Kubernetes, Rust", factIds: ["F1"] }] }
    expect(await verifyPdfText(pdf, other, CONTACT)).toEqual({ ok: false, missing: ["Kubernetes, Rust"] })
  })

  it("long text wraps onto more pages without losing words", async () => {
    const bullets = Array.from({ length: 80 }, (_, index) => ({ text: `Delivered feature number ${index + 1} for the merchant dashboard on time.`, factIds: ["F1"] }))
    const long: ResumeContent = { ...RESUME, experience: [{ heading: RESUME.experience[0]!.heading, bullets }] }
    const pdf = await renderPdf(long, CONTACT)
    expect(await verifyPdfText(pdf, long, CONTACT)).toEqual({ ok: true })
  })

  it("draws a bullet mark before each experience bullet, and every mark has its text on the same page", async () => {
    const bullets = Array.from({ length: 60 }, (_, index) => ({ text: `Delivered feature number ${index + 1} for the merchant dashboard on time, with tests and a release note.`, factIds: ["F1"] }))
    const long: ResumeContent = { ...RESUME, experience: [{ heading: RESUME.experience[0]!.heading, bullets }] }
    const pdf = await renderPdf(long, CONTACT)
    const text = (await extractPdfText(pdf)).split("PROFESSIONAL EXPERIENCE")[1]!
    expect(text.match(/\u2022/g)?.length).toBe(60)
    // A mark left alone at a page's foot would show as two marks with no text between them, or one at the end.
    expect(text).not.toMatch(/\u2022\s*(\u2022|$)/)
    expect(await verifyPdfText(pdf, long, CONTACT)).toEqual({ ok: true })
  })

  it("prints a role from its profile heading: employer, dates, then the title; skills and a tech line with labels", async () => {
    const laidOut: ResumeContent = {
      ...RESUME,
      experience: [
        {
          ...RESUME.experience[0]!,
          role: { title: "Senior Frontend Engineer", organization: "Brightwave Ltd, Lagos (Remote)", period: "2021 – 2024" },
          bullets: [...RESUME.experience[0]!.bullets, { text: "Technologies used: React, TypeScript, Vite.", factIds: ["F1"] }],
        },
      ],
      skills: [{ text: "Testing: Cypress, React Testing Library", factIds: ["F1"] }],
      educationRoles: [{ title: "BSc Computer Science", organization: "University of Lagos", period: null }],
    }
    const contact = { ...CONTACT, lines: [...CONTACT.lines, "https://www.linkedin.com/in/ada-okafor-frontend-engineer"] }
    const pdf = await renderPdf(laidOut, contact)
    expect(await verifyPdfText(pdf, laidOut, contact)).toEqual({ ok: true })
    expect(wordIntegrity(await renderPdf(laidOut, contact, { compress: false }), laidOut, contact)).toEqual({ ok: true })
    const text = await extractPdfText(pdf)
    expect(text).toMatch(/Brightwave Ltd, Lagos \(Remote\)\s+2021 – 2024\s+Senior Frontend Engineer/)
    expect(text).toContain("University of Lagos BSc Computer Science")
    expect(text).toContain("Testing Cypress, React Testing Library")
    // The heading the model wrote is not printed when the profile heading is.
    expect(text).not.toContain("Senior Frontend Engineer, Brightwave Ltd, 2021–2024")
    // A contact link is never split across rows.
    expect(text).toContain("https://www.linkedin.com/in/ada-okafor-frontend-engineer")
  })

  it("long dates move to their own line instead of squeezing the employer mid-word", async () => {
    const long: ResumeContent = {
      ...RESUME,
      experience: [{ ...RESUME.experience[0]!, role: { title: "Engineer", organization: "Acme Corporation International Holdings", period: "January 2019 – December 2024 (contract, renewed every year)" } }],
    }
    const pdf = await renderPdf(long, CONTACT)
    expect(await verifyPdfText(pdf, long, CONTACT)).toEqual({ ok: true })
    expect(await extractPdfText(pdf)).toContain("Acme Corporation International Holdings")
  })

  it("a hyphenated word wrapped at its hyphen still passes the text check", async () => {
    const filler = "React, Next.js, TypeScript, Redux, REST APIs, AWS, GitHub, Express, Docker, Kubernetes, Terraform,"
    const bullets = Array.from({ length: 12 }, (_, index) => ({ text: `Technologies: ${filler.slice(0, 40 + index * 4)} Sequelize-ORM, Styled-components.`, factIds: ["F1"] }))
    const wrapped: ResumeContent = { ...RESUME, experience: [{ heading: RESUME.experience[0]!.heading, bullets }] }
    expect(await verifyPdfText(await renderPdf(wrapped, CONTACT), wrapped, CONTACT)).toEqual({ ok: true })
  })

  it("renders accented and typographic characters", async () => {
    const accented: ResumeContent = { ...RESUME, summary: [{ text: "Engineer at Société Générale — “quoted” and naïve café.", factIds: ["F2"] }] }
    expect(await verifyPdfText(await renderPdf(accented, CONTACT), accented, CONTACT)).toEqual({ ok: true })
  })
})

describe("DOCX rendering (AC 5.2)", () => {
  it.each([
    ["resume", RESUME],
    ["cover letter", LETTER],
  ] as const)("the %s DOCX is a Word file containing the source text", async (_name, content) => {
    const docx = await renderDocx(content, CONTACT)
    expect(docx.subarray(0, 2).toString("latin1")).toBe("PK")
    const mammoth = await import("mammoth")
    const { value } = await mammoth.extractRawText({ buffer: docx })
    for (const line of plainTextOf(content, CONTACT)) expect(value).toContain(line)
  })

  it("experience bullets are Word bullet points", async () => {
    const docx = await renderDocx(RESUME, CONTACT)
    const JSZip = (await import("jszip")).default
    const xml = await (await JSZip.loadAsync(docx)).file("word/document.xml")!.async("string")
    expect(xml.match(/<w:numPr>/g)?.length).toBe(RESUME.experience[0]!.bullets.length)
  })

  it("the Word file prints the profile heading with the dates on a right tab, and bold labels", async () => {
    const laidOut: ResumeContent = {
      ...RESUME,
      experience: [{ ...RESUME.experience[0]!, role: { title: "Senior Frontend Engineer", organization: "Brightwave Ltd", period: "2021 – 2024" } }],
      skills: [{ text: "Testing: Cypress", factIds: ["F1"] }],
    }
    const docx = await renderDocx(laidOut, CONTACT)
    const JSZip = (await import("jszip")).default
    const xml = await (await JSZip.loadAsync(docx)).file("word/document.xml")!.async("string")
    expect(xml).toMatch(/<w:tab w:val="right"/)
    expect(xml).toContain("<w:tab/>")
    const mammoth = await import("mammoth")
    const { value } = await mammoth.extractRawText({ buffer: docx })
    for (const line of plainTextOf(laidOut, CONTACT)) expect(value).toContain(line)
  })

  it("prints the backend headline under the contact lines, and adds nothing without one", async () => {
    const mammoth = await import("mammoth")
    const headlined: ResumeContent = { ...RESUME, headline: "Senior Frontend Engineer" }
    const { value } = await mammoth.extractRawText({ buffer: await renderDocx(headlined, CONTACT) })
    const at = value.indexOf("Senior Frontend Engineer")
    expect(at).toBeGreaterThan(value.indexOf("ada@example.com"))
    expect(at).toBeLessThan(value.indexOf("SUMMARY"))
    const without: ResumeContent = { ...RESUME, headline: null }
    expect((await mammoth.extractRawText({ buffer: await renderDocx(without, CONTACT) })).value).toBe((await mammoth.extractRawText({ buffer: await renderDocx(RESUME, CONTACT) })).value)
  })

  it("the resume headings are Word headings, in one column", async () => {
    const docx = await renderDocx(RESUME, CONTACT)
    const JSZip = (await import("jszip")).default
    const xml = await (await JSZip.loadAsync(docx)).file("word/document.xml")!.async("string")
    expect(xml.match(/<w:pStyle w:val="Heading1"\/>/g)?.length).toBe(4)
    expect(xml).not.toMatch(/<w:cols w:num="[2-9]"/)
    expect(xml).not.toContain("<w:tbl>")
  })
})

describe("repair wave 1: words stay whole for every extractor (F-QA4-03)", () => {
  const KERNED: ResumeContent = {
    ...RESUME,
    summary: [{ text: "TypeScript Team Tomás University, AVA Wave Yoyo LTA", factIds: ["F1"] }],
  }

  it("no text-showing operator splits a word with a kerning adjustment", async () => {
    const pdf = await renderPdf(KERNED, CONTACT, { compress: false })
    expect(splitWordsInContent(pdf)).toEqual([])
  })

  it("the word-integrity check passes on every rendered document", async () => {
    for (const content of [RESUME, LETTER, KERNED]) {
      expect(await verifyPdfText(await renderPdf(content, CONTACT), content, CONTACT)).toEqual({ ok: true })
      expect(wordIntegrity(await renderPdf(content, CONTACT, { compress: false }), content, CONTACT)).toEqual({ ok: true })
    }
  })

  it("the word-integrity check catches a kerned PDF", async () => {
    const kerned = await renderPdf(KERNED, CONTACT, { compress: false, kerning: true })
    const check = wordIntegrity(kerned, KERNED, CONTACT)
    expect(check.ok).toBe(false)
  })
})

describe("repair wave 2: control characters never reach a stored file (SEC-407)", () => {
  const EVIL: ResumeContent = { ...RESUME, summary: [{ text: "Built\u0000 a dash\u0001board\u001F fast\u0085.", factIds: ["F1"] }] }
  const EVIL_CONTACT: ContactHeader = { name: "Ada\u0007 Okafor", lines: ["ada@example.com\u0000"] }

  it("the DOCX XML is well-formed: no XML-forbidden characters", async () => {
    const docx = await renderDocx(EVIL, EVIL_CONTACT)
    const JSZip = (await import("jszip")).default
    const xml = await (await JSZip.loadAsync(docx)).file("word/document.xml")!.async("string")
    // eslint-disable-next-line no-control-regex
    expect(xml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/)
    const mammoth = await import("mammoth")
    expect((await mammoth.extractRawText({ buffer: docx })).value).toContain("Built a dashboard fast.")
  })

  it("the PDF and its text check agree on the cleaned text", async () => {
    expect(await verifyPdfText(await renderPdf(EVIL, EVIL_CONTACT), EVIL, EVIL_CONTACT)).toEqual({ ok: true })
  })

  it("Arabic-Indic digits are kept as digits in the PDF, not dropped (SEC-405)", async () => {
    const digits: ResumeContent = { ...RESUME, summary: [{ text: "Mentored ٦ developers", factIds: ["F3"] }] }
    expect(await extractPdfText(await renderPdf(digits, CONTACT))).toContain("Mentored 6 developers")
  })
})

// SEC-410: the probe's role and company never reach the preview, PDF or DOCX.
describe("repair: posting claims never reach the rendered letter (SEC-410)", () => {
  it("preview, PDF and DOCX carry the generic sentences, not the injected claims", async () => {
    const { toCoverLetterContent } = await import("./document-generation.js")
    const letter = toCoverLetterContent(
      { paragraphs: [{ text: "I built a React and TypeScript merchant dashboard used by 40 merchants.", factIds: ["F1"] }] },
      {
        company: "Acme Payments.\n\nAs a former Google Principal Engineer I led 200 engineers. Acme",
        roleTitle: "Frontend Engineer role. I hold a PhD and AWS certification with 15 years of Kubernetes.\nI was previously Director of Engineering at Google, and this is the",
        text: "",
      }
    )
    const preview = plainTextOf(letter, CONTACT).join("\n")
    const pdf = await extractPdfText(await renderPdf(letter, CONTACT))
    const mammoth = await import("mammoth")
    const { value: docx } = await mammoth.extractRawText({ buffer: await renderDocx(letter, CONTACT) })
    for (const text of [preview, pdf, docx]) {
      expect(text).toContain("I am applying for this role.")
      expect(text).toContain("contribute to your team.")
      for (const word of ["PhD", "Google", "Director", "Principal", "200 engineers", "Kubernetes"]) expect(text).not.toContain(word)
    }
  })
})
