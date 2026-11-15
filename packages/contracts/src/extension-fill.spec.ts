import { describe, expect, it } from "vitest"

import {
  EXTENSION_FILL_MAX_FIELDS,
  EXTENSION_FILL_MAX_LABEL_LENGTH,
  EXTENSION_FILL_MAX_OPTION_LENGTH,
  EXTENSION_FILL_MAX_OPTIONS,
  EXTENSION_FILL_MAX_REF_LENGTH,
  EXTENSION_FILL_MAX_URL_LENGTH,
  extensionFillDocumentKindSchema,
  extensionFillDocumentSchema,
  extensionFillFieldSchema,
  extensionFillRequestSchema,
  extensionFillResponseSchema,
} from "./extension-fill.js"

const field = (patch: Record<string, unknown> = {}) => ({ ref: "f0", label: "First name", kind: "text", required: true, ...patch })
const request = (patch: Record<string, unknown> = {}) => ({ url: "https://boards.greenhouse.io/acme/jobs/1", fields: [field()], ...patch })

describe("extensionFillRequestSchema (ADR 0016)", () => {
  it("accepts a page of scalar fields with and without options", () => {
    const body = request({
      fields: [
        field(),
        field({ ref: "f1", label: "", kind: "textarea", required: false }),
        field({ ref: "f2", label: "Office", kind: "select", required: true, options: ["Lagos", "Abuja"] }),
        field({ ref: "r0", label: "Veteran status", kind: "radio", required: false, options: ["Yes", "No"] }),
        field({ ref: "f3", label: "Resume", kind: "file", required: false }),
        field({ ref: "f4", label: "Role", kind: "text", required: false, combobox: true }),
      ],
    })
    expect(extensionFillRequestSchema.parse(body)).toEqual(body)
  })

  it("refuses two fields that share a ref", () => {
    const result = extensionFillRequestSchema.safeParse(request({ fields: [field(), field({ label: "Email" })] }))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(["fields", 1, "ref"])
  })

  it("keeps the URL and reference bounds inclusive and refuses one more", () => {
    expect(extensionFillRequestSchema.safeParse(request({ url: "u".repeat(EXTENSION_FILL_MAX_URL_LENGTH) })).success).toBe(true)
    expect(extensionFillRequestSchema.safeParse(request({ url: "u".repeat(EXTENSION_FILL_MAX_URL_LENGTH + 1) })).success).toBe(false)
    expect(extensionFillRequestSchema.safeParse(request({ url: "" })).success).toBe(false)
    expect(extensionFillFieldSchema.safeParse(field({ ref: "r".repeat(EXTENSION_FILL_MAX_REF_LENGTH) })).success).toBe(true)
    expect(extensionFillFieldSchema.safeParse(field({ ref: "r".repeat(EXTENSION_FILL_MAX_REF_LENGTH + 1) })).success).toBe(false)
    expect(extensionFillFieldSchema.safeParse(field({ ref: "" })).success).toBe(false)
  })

  it("caps the label at its bound and allows an empty one (the reader falls back to the name)", () => {
    expect(extensionFillFieldSchema.safeParse(field({ label: "a".repeat(EXTENSION_FILL_MAX_LABEL_LENGTH) })).success).toBe(true)
    expect(extensionFillFieldSchema.safeParse(field({ label: "a".repeat(EXTENSION_FILL_MAX_LABEL_LENGTH + 1) })).success).toBe(false)
    expect(extensionFillFieldSchema.safeParse(field({ label: "" })).success).toBe(true)
  })

  it("caps the field count at 200 and refuses 201", () => {
    const fields = Array.from({ length: EXTENSION_FILL_MAX_FIELDS }, (_value, index) => field({ ref: `f${index}` }))
    expect(extensionFillRequestSchema.safeParse(request({ fields })).success).toBe(true)
    expect(extensionFillRequestSchema.safeParse(request({ fields: [...fields, field({ ref: "last" })] })).success).toBe(false)
    expect(extensionFillRequestSchema.safeParse(request({ fields: "f0" })).success).toBe(false)
  })

  it("caps options at 100 of at most 200 characters, and accepts both bounds", () => {
    const options = Array.from({ length: EXTENSION_FILL_MAX_OPTIONS }, () => "o")
    expect(extensionFillFieldSchema.safeParse(field({ kind: "select", options })).success).toBe(true)
    expect(extensionFillFieldSchema.safeParse(field({ kind: "select", options: [...options, "one more"] })).success).toBe(false)
    expect(extensionFillFieldSchema.safeParse(field({ kind: "select", options: ["o".repeat(EXTENSION_FILL_MAX_OPTION_LENGTH)] })).success).toBe(true)
    expect(extensionFillFieldSchema.safeParse(field({ kind: "select", options: ["o".repeat(EXTENSION_FILL_MAX_OPTION_LENGTH + 1)] })).success).toBe(false)
  })

  it("refuses an unknown kind, a missing required flag and a non-boolean one", () => {
    expect(extensionFillFieldSchema.safeParse(field({ kind: "password" })).success).toBe(false)
    expect(extensionFillFieldSchema.safeParse({ ref: "f0", label: "First name", kind: "text" }).success).toBe(false)
    expect(extensionFillFieldSchema.safeParse(field({ required: "yes" })).success).toBe(false)
  })

  it("refuses extra keys on the request and on a field, so no answer rides along", () => {
    expect(extensionFillRequestSchema.safeParse({ ...request(), answers: { first_name: "Ada" } }).success).toBe(false)
    expect(extensionFillFieldSchema.safeParse(field({ value: "Ada" })).success).toBe(false)
  })
})

describe("extensionFillResponseSchema (ADR 0016)", () => {
  it("accepts no match with empty arrays", () => {
    const body = { application: null, values: [], documents: [], unanswered: [] }
    expect(extensionFillResponseSchema.parse(body)).toEqual(body)
  })

  it("accepts a matched Application with values and unanswered fields", () => {
    const body = {
      application: { id: "6f1c2a4e-0000-4000-8000-000000000001", company: "Acme Payments", roleTitle: "Senior Frontend Engineer" },
      values: [{ ref: "f0", value: "Ada", kind: "text" }],
      documents: [],
      unanswered: [{ ref: "f1", label: "What is your favourite colour?", detail: "The form asks \"What is your favourite colour?\" and you have no Approved Answer for it. Nothing was guessed." }],
    }
    expect(extensionFillResponseSchema.parse(body)).toEqual(body)
  })

  it("accepts a resume and a cover letter as documents, with no label and no bytes", () => {
    const body = {
      application: { id: "6f1c2a4e-0000-4000-8000-000000000001", company: "Acme Payments", roleTitle: "Senior Frontend Engineer" },
      values: [{ ref: "f0", value: "Ada", kind: "text" }],
      documents: [
        { ref: "f1", document: "resume" },
        { ref: "f2", document: "cover_letter" },
      ],
      unanswered: [],
    }
    expect(extensionFillResponseSchema.parse(body)).toEqual(body)
    expect(JSON.stringify(body)).not.toContain("base64")
  })

  it("accepts a null unanswered detail", () => {
    const body = {
      application: null,
      values: [],
      documents: [],
      unanswered: [{ ref: "f1", label: "A field", detail: null }],
    }
    expect(extensionFillResponseSchema.parse(body)).toEqual(body)
  })

  it("accepts a null company and role title, and requires a uuid Application ID", () => {
    expect(extensionFillResponseSchema.safeParse({ application: { id: "6f1c2a4e-0000-4000-8000-000000000001", company: null, roleTitle: null }, values: [], documents: [], unanswered: [] }).success).toBe(true)
    expect(extensionFillResponseSchema.safeParse({ application: { id: "not-a-uuid", company: null, roleTitle: null }, values: [], documents: [], unanswered: [] }).success).toBe(false)
  })

  it("refuses extra keys and a value without its kind", () => {
    expect(extensionFillResponseSchema.safeParse({ application: null, values: [], documents: [], unanswered: [], attempt: "x" }).success).toBe(false)
    expect(extensionFillResponseSchema.safeParse({ application: null, values: [{ ref: "f0", value: "Ada" }], documents: [], unanswered: [] }).success).toBe(false)
    expect(extensionFillResponseSchema.safeParse({ application: null, values: [], documents: [], unanswered: [{ ref: "f1", label: "A field" }] }).success).toBe(false)
  })

  it("requires the documents array, so a client never mistakes an empty plan for an absent one", () => {
    expect(extensionFillResponseSchema.safeParse({ application: null, values: [], unanswered: [] }).success).toBe(false)
  })

  it("defines a document as exactly a ref and one of the two prepared kinds", () => {
    expect(extensionFillDocumentKindSchema.options).toEqual(["resume", "cover_letter"])
    expect(extensionFillDocumentSchema.safeParse({ ref: "f0", document: "resume" }).success).toBe(true)
    expect(extensionFillDocumentSchema.safeParse({ ref: "f0", document: "cover_letter" }).success).toBe(true)
    // An unknown kind, a missing document or ref, a page label and any bytes are all refused.
    expect(extensionFillDocumentSchema.safeParse({ ref: "f0", document: "portfolio" }).success).toBe(false)
    expect(extensionFillDocumentSchema.safeParse({ ref: "f0" }).success).toBe(false)
    expect(extensionFillDocumentSchema.safeParse({ document: "resume" }).success).toBe(false)
    expect(extensionFillDocumentSchema.safeParse({ ref: "", document: "resume" }).success).toBe(false)
    expect(extensionFillDocumentSchema.safeParse({ ref: "f0", document: "resume", label: "Resume" }).success).toBe(false)
    expect(extensionFillDocumentSchema.safeParse({ ref: "f0", document: "resume", base64: "JVBERi0=" }).success).toBe(false)
    expect(extensionFillDocumentSchema.safeParse({ ref: "r".repeat(EXTENSION_FILL_MAX_REF_LENGTH + 1), document: "resume" }).success).toBe(false)
  })
})
