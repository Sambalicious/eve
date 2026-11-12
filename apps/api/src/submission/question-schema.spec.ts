import { describe, expect, it } from "vitest"

import type { BoardHttp } from "../discovery/sources/board-http.js"
import type { FormField } from "./answer-assignment.js"
import { attachSchema, createGreenhouseQuestionSchemas, greenhouseJobRef } from "./question-schema.js"

const control = (ref: string, extra: Partial<FormField> = {}): FormField => ({ ref, label: "page label", kind: "select", required: true, ...extra })
const Q = { text: "Are you legally authorized to work in Nigeria?", fieldName: "question_1" }

describe("greenhouseJobRef", () => {
  it.each([
    ["https://boards.greenhouse.io/acme/jobs/123", { token: "acme", jobId: "123" }],
    ["https://job-boards.greenhouse.io/acme/jobs/4567890", { token: "acme", jobId: "4567890" }],
    ["https://job-boards.eu.greenhouse.io/acme/jobs/9", { token: "acme", jobId: "9" }],
  ])("%s", (url, ref) => expect(greenhouseJobRef(url)).toEqual(ref))
  it.each(["https://jobs.lever.co/acme/123", "https://boards.greenhouse.io.evil.test/acme/jobs/1", "https://boards.greenhouse.io/acme/jobs/x", "not a url"])("%s -> null", (url) => {
    expect(greenhouseJobRef(url)).toBeNull()
  })
})

describe("createGreenhouseQuestionSchemas", () => {
  const http = (body: unknown, urls: string[] = []): BoardHttp => ({
    getJson: async (url) => {
      urls.push(url)
      if (body instanceof Error) throw body
      return body
    },
    getText: async () => "",
  })
  it("reads the job's questions from the public board API by field name", async () => {
    const urls: string[] = []
    const body = { questions: [{ label: "Are you legally authorized to work in Nigeria?", fields: [{ name: "question_1", type: "multi_value_single_select", values: [{ label: "Yes" }, { label: "No" }] }] }] }
    expect(await createGreenhouseQuestionSchemas(http(body, urls)).forPosting({ applicationSystem: "greenhouse", applyUrl: "https://boards.greenhouse.io/acme/jobs/42" })).toEqual([
      { text: "Are you legally authorized to work in Nigeria?", fieldName: "question_1", options: ["Yes", "No"] },
    ])
    expect(urls).toEqual(["https://boards-api.greenhouse.io/v1/boards/acme/jobs/42?questions=true"])
  })
  it("Lever, Ashby, an unknown URL, a malformed body or a read error give no schema", async () => {
    const ok = http({ questions: [] })
    expect(await createGreenhouseQuestionSchemas(ok).forPosting({ applicationSystem: "lever", applyUrl: "https://jobs.lever.co/a/b" })).toBeNull()
    expect(await createGreenhouseQuestionSchemas(ok).forPosting({ applicationSystem: "greenhouse", applyUrl: "https://example.test/a" })).toBeNull()
    expect(await createGreenhouseQuestionSchemas(http({ questions: "x" })).forPosting({ applicationSystem: "greenhouse", applyUrl: "https://boards.greenhouse.io/a/jobs/1" })).toBeNull()
    expect(await createGreenhouseQuestionSchemas(http(new Error("down"))).forPosting({ applicationSystem: "greenhouse", applyUrl: "https://boards.greenhouse.io/a/jobs/1" })).toBeNull()
  })
})

describe("attachSchema (match by name or id, never by label)", () => {
  it("matches by name or by id", () => {
    const out = attachSchema([control("f0", { fieldName: "question_1" }), control("f1", { fieldId: "question_2" })], [Q, { text: "T2", fieldName: "question_2" }])
    expect(out.map((c) => c.schemaQuestion?.text)).toEqual([Q.text, "T2"])
  })
  it("a label equal to the schema text does not match", () => {
    expect(attachSchema([control("f0", { label: Q.text, fieldName: "other" })], [Q])[0]?.schemaQuestion).toBeUndefined()
  })
  it("a schema field claimed by two controls matches neither", () => {
    const out = attachSchema([control("f0", { fieldName: "question_1" }), control("f1", { fieldId: "question_1" })], [Q])
    expect(out.every((c) => c.schemaQuestion === undefined)).toBe(true)
  })
  it("drops a schemaQuestion that arrived on the control, and keeps it absent with no schema", () => {
    const forged = control("f0", { fieldName: "x", schemaQuestion: { text: "forged", fieldName: "x" } })
    expect(attachSchema([forged], null)[0]?.schemaQuestion).toBeUndefined()
    expect(attachSchema([forged], [Q])[0]?.schemaQuestion).toBeUndefined()
  })
})
