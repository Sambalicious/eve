import { describe, expect, it } from "vitest"

import { paragraphBombDocx, zipBombDocx } from "../../test/support/hostile-resumes.js"
import { buildDocx, buildPlainZip } from "../../test/support/resume-fixtures.js"
import { DOCX_LIMITS, preflightDocx } from "./docx-preflight.js"

describe("preflightDocx", () => {
  it("accepts a normal resume", () => {
    expect(preflightDocx(buildDocx())).toEqual({ ok: true })
  })

  it("refuses a document part that inflates past the limit", () => {
    expect(preflightDocx(zipBombDocx(64))).toEqual({ ok: false, reason: "too_large_uncompressed" })
  })

  it("refuses a zip whose headers lie about the uncompressed size, by inflating with a cap", () => {
    expect(preflightDocx(zipBombDocx(64, { lieAboutSize: true }))).toEqual({ ok: false, reason: "too_large_uncompressed" })
  })

  it("refuses a highly compressed document part (ratio above the limit)", () => {
    // 150k paragraphs: 4.9 MB of XML from 15 KB (343:1), under the size cap but over the ratio cap.
    expect(preflightDocx(paragraphBombDocx(150_000))).toEqual({ ok: false, reason: "compression_ratio" })
  })

  it("refuses the reviewer's 4 million paragraph bomb (397 KB)", () => {
    expect(preflightDocx(paragraphBombDocx(4_000_000)).ok).toBe(false)
  })

  it("refuses a zip with too many entries", () => {
    const many = Array.from({ length: DOCX_LIMITS.maxEntries + 1 }, (_, i) => [`word/media/x${i}.xml`, "<a/>"] as const)
    expect(preflightDocx(buildDocx(undefined, many))).toEqual({ ok: false, reason: "too_many_entries" })
  })

  it("refuses a zip without word/document.xml", () => {
    expect(preflightDocx(buildPlainZip())).toEqual({ ok: false, reason: "not_a_docx" })
  })

  it("refuses bytes that are not a zip", () => {
    expect(preflightDocx(Buffer.from("PK\u0003\u0004 not really a zip"))).toEqual({ ok: false, reason: "not_a_docx" })
  })
})
