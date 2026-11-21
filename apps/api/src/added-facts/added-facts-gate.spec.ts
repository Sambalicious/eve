import { describe, expect, it } from "vitest"

import { addedFactsDropDetail, confirmationRequired, documentsStale } from "./added-facts-gate.js"

describe("FEAT-0017 documentsStale", () => {
  it("is false with no documents", () => {
    expect(documentsStale({ flagOn: true, applicationVersion: 3, documents: [] })).toBe(false)
  })

  it("with the flag on, any counter mismatch is stale", () => {
    expect(documentsStale({ flagOn: true, applicationVersion: 3, documents: [{ version: 2, cited: [] }] })).toBe(true)
    expect(documentsStale({ flagOn: true, applicationVersion: 3, documents: [{ version: 3, cited: ["f"] }] })).toBe(false)
  })

  it("with the flag off, a mismatch is stale only when a document cites an added fact (A-11 r1, SEC-001)", () => {
    expect(documentsStale({ flagOn: false, applicationVersion: 3, documents: [{ version: 2, cited: [] }, { version: 2, cited: [] }] })).toBe(false)
    expect(documentsStale({ flagOn: false, applicationVersion: 3, documents: [{ version: 2, cited: [] }, { version: 2, cited: ["f"] }] })).toBe(true)
  })
})

const base = {
  flagOn: true,
  applicationVersion: 3,
  confirmedVersion: 3,
  documents: [{ version: 3, cited: ["a1"] }],
  postingStatus: "skipped",
  baseDrop: "not_ranked" as const,
  match: { lifted: true },
}

describe("FEAT-0017 addedFactsDropDetail", () => {
  it("drops stale documents first, whatever else holds", () => {
    expect(addedFactsDropDetail({ ...base, documents: [{ version: 2, cited: [] }] })).toBe("documents_stale")
  })

  it("a ranked posting is submittable and needs no confirmation", () => {
    expect(addedFactsDropDetail({ ...base, postingStatus: "ranked", baseDrop: null, confirmedVersion: null })).toBeNull()
  })

  it("with the flag off the existing result stands", () => {
    expect(addedFactsDropDetail({ ...base, flagOn: false })).toBe("not_ranked")
  })

  it("an unlifted Application keeps the existing result", () => {
    expect(addedFactsDropDetail({ ...base, match: { lifted: false } })).toBe("not_ranked")
    expect(addedFactsDropDetail({ ...base, match: null })).toBe("not_ranked")
  })

  it("a lifted Application not confirmed for the counter drops as added_facts_unconfirmed", () => {
    expect(addedFactsDropDetail({ ...base, confirmedVersion: 2 })).toBe("added_facts_unconfirmed")
    expect(addedFactsDropDetail({ ...base, confirmedVersion: null })).toBe("added_facts_unconfirmed")
  })

  it("a confirmed lift is a submittable basis for not_ranked and override_mismatch", () => {
    expect(addedFactsDropDetail({ ...base, baseDrop: "not_ranked" })).toBeNull()
    expect(addedFactsDropDetail({ ...base, baseDrop: "override_mismatch" })).toBeNull()
  })

  it("any other existing result still stands", () => {
    expect(addedFactsDropDetail({ ...base, baseDrop: "hidden" })).toBe("hidden")
    expect(addedFactsDropDetail({ ...base, baseDrop: "closed" })).toBe("closed")
  })
})

describe("FEAT-0017 confirmationRequired", () => {
  it("is true only for a lifted Application whose confirmation misses the counter, with the flag on", () => {
    expect(confirmationRequired({ flagOn: true, applicationVersion: 4, confirmedVersion: 3, match: { lifted: true } })).toBe(true)
    expect(confirmationRequired({ flagOn: true, applicationVersion: 4, confirmedVersion: 4, match: { lifted: true } })).toBe(false)
    expect(confirmationRequired({ flagOn: true, applicationVersion: 4, confirmedVersion: 3, match: { lifted: false } })).toBe(false)
    expect(confirmationRequired({ flagOn: true, applicationVersion: 4, confirmedVersion: 3, match: null })).toBe(false)
    expect(confirmationRequired({ flagOn: false, applicationVersion: 4, confirmedVersion: 3, match: { lifted: true } })).toBe(false)
  })
})
