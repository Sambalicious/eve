import { describe, expect, it } from "vitest"

import { downloadName } from "../documents/documents.service.js"
import { hiddenReason, buildVisibilityContext } from "./visibility.js"
import { pasteFingerprint, pasteLockKey, publicLink } from "./pasted-description-store.js"

/** EPIC-0010 pure rules: fingerprint (PD-5.4, I-3), URN hiding, lock key, visibility exemption (OQ-5), download name (DOC:85). */
describe("pasted descriptions", () => {
  it("RP:214 the fingerprint ignores whitespace runs in the text but keeps case and punctuation", () => {
    const base = pasteFingerprint("Engineer", "Paystack", "Build React\n\nfeatures.")
    expect(pasteFingerprint("Engineer", "Paystack", "Build  React features.")).toBe(base)
    expect(pasteFingerprint("engineer", "Paystack", "Build React features.")).not.toBe(base)
    expect(pasteFingerprint("Engineer", "Paystack", "Build React features")).not.toBe(base)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
  })

  it("never sends the synthetic URN; keeps real links", () => {
    expect(publicLink("urn:eve:pasted:5b0e")).toBeNull()
    expect(publicLink("https://linkedin.com/jobs/view/1")).toBe("https://linkedin.com/jobs/view/1")
  })

  it("lock keys are 52-bit, per Candidate and key", () => {
    const key = pasteLockKey("c1", "k")
    expect(Number.isSafeInteger(key)).toBe(true)
    expect(pasteLockKey("c2", "k")).not.toBe(key)
  })

  it("EV:149 a pasted description is never hidden, even untitled-off-target and undated", () => {
    const ctx = buildVisibilityContext({ targetRoleFamilies: [], seniorityFloor: "hide_entry_level" }, new Date("2026-11-02T09:00:00Z"))
    const facts = { titled: true, prefilterSkip: null, roleFamily: null, seniorityMarker: "entry", postedAt: null }
    expect(hiddenReason({ ...facts, pastedDescription: false }, ctx)).toBe("off_target")
    expect(hiddenReason({ ...facts, pastedDescription: true }, ctx)).toBeNull()
  })

  it("DOC:85 a pasted Application's download name leaves out the synthetic requisition", () => {
    expect(downloadName({ company: "Paystack", requisition_id: "pasted:8b0e" }, "resume", "pdf")).toBe("Resume - Paystack.pdf")
    expect(downloadName({ company: "Acme", requisition_id: "R-1042" }, "resume", "pdf")).toBe("Resume - Acme - R-1042.pdf")
  })
})
