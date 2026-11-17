import { describe, expect, it } from "vitest"

import { downloadName } from "./documents.service.js"

/** No UUID, requisition or synthetic pasted key ever reaches the filename: employers see a person. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

function expectClean(filename: string) {
  expect(filename).not.toMatch(UUID)
  expect(filename).not.toContain("pasted:")
  expect(filename).not.toContain(" -  - ")
  expect(filename).not.toContain("  ")
  expect(filename).toBe(filename.trim())
  expect(filename).toMatch(/^[\x20-\x7e]+$/)
}

describe("downloadName", () => {
  it("is name, kind and company", () => {
    expect(downloadName("Samuel Ayegbusi", "ClickHouse", "resume", "pdf")).toBe("Samuel Ayegbusi - Resume - ClickHouse.pdf")
    expect(downloadName("Samuel Ayegbusi", "ClickHouse", "cover_letter", "docx")).toBe("Samuel Ayegbusi - Cover Letter - ClickHouse.docx")
  })

  it("never includes the requisition or application id", () => {
    const filename = downloadName("Samuel Ayegbusi", "ClickHouse", "resume", "pdf")
    expectClean(filename)
    expect(filename).not.toContain("R-1042")
  })

  it("omits a missing company", () => {
    expect(downloadName("Ada Okafor", null, "resume", "pdf")).toBe("Ada Okafor - Resume.pdf")
    expect(downloadName("Ada Okafor", "", "cover_letter", "pdf")).toBe("Ada Okafor - Cover Letter.pdf")
    expect(downloadName("Ada Okafor", "   ", "resume", "docx")).toBe("Ada Okafor - Resume.docx")
  })

  it("omits a missing name", () => {
    expect(downloadName("", "Acme Payments", "resume", "pdf")).toBe("Resume - Acme Payments.pdf")
    expect(downloadName("   ", "Acme Payments", "cover_letter", "pdf")).toBe("Cover Letter - Acme Payments.pdf")
  })

  it("falls back to the kind alone when both are missing", () => {
    expect(downloadName("", null, "resume", "pdf")).toBe("Resume.pdf")
    expect(downloadName("", "", "cover_letter", "docx")).toBe("Cover Letter.docx")
  })

  it("folds accents and strips characters a filesystem forbids", () => {
    expect(downloadName("Ayégbusi, Samuel", 'Ac/me: "Pay*ments";?<>|', "resume", "pdf")).toBe("Ayegbusi, Samuel - Resume - Acme Payments.pdf")
    expect(downloadName("José Müller 🚀", "ClickHouse", "cover_letter", "pdf")).toBe("Jose Muller - Cover Letter - ClickHouse.pdf")
  })

  it("drops a part that is nothing but non-ASCII and forbidden characters", () => {
    expect(downloadName("🚀 🚀", "ClickHouse", "resume", "pdf")).toBe("Resume - ClickHouse.pdf")
  })

  it("caps each part at 60 characters without leaving a dangling separator", () => {
    const filename = downloadName("A".repeat(200), "B".repeat(200), "cover_letter", "pdf")
    const parts = filename.split(" - ")
    expect(parts).toEqual(["A".repeat(60), "Cover Letter", `${"B".repeat(60)}.pdf`])
    expect(filename).toHaveLength(60 + 3 + 12 + 3 + 60 + 4)
    expectClean(filename)
  })

  it("caps a part that is cut exactly at a space without leaving a trailing one", () => {
    const name = `${"A".repeat(59)} bcd`
    expect(downloadName(name, "ClickHouse", "resume", "pdf")).toBe(`${"A".repeat(59)} - Resume - ClickHouse.pdf`)
  })
})
