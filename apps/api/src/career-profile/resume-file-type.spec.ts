import { describe, expect, it } from "vitest"

import { PNG_BYTES, buildDocx, buildPdf, buildPlainZip } from "../../test/support/resume-fixtures.js"
import { sniffResumeType } from "./resume-file-type.js"

describe("sniffResumeType", () => {
  it("recognises a PDF by its header and EOF marker", () => {
    expect(sniffResumeType(buildPdf())).toBe("application/pdf")
  })

  it("recognises a DOCX by its zip entries", () => {
    expect(sniffResumeType(buildDocx())).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
  })

  it.each([
    ["a PNG", PNG_BYTES],
    ["a zip without word/document.xml", buildPlainZip()],
    ["plain text named .pdf", Buffer.from("not a pdf at all")],
    ["a truncated PDF without %%EOF", buildPdf().subarray(0, 200)],
    ["an empty file", Buffer.alloc(0)],
    ["HTML", Buffer.from("<html><body>%PDF-1.4</body></html>")],
  ])("refuses %s", (_label, bytes) => {
    expect(sniffResumeType(bytes)).toBeUndefined()
  })
})
