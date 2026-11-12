import { APPLY_ANYWAY_ERROR_MESSAGES, CSRF_HEADER } from "@eve/contracts"
import { afterEach, describe, expect, it } from "vitest"

import { linkFakes } from "./apply-anyway-fake"
import { TEST_CSRF_TOKEN } from "./contract-handlers"
import { createDiscoveryApi, rankedPosting } from "./discovery-api"
import { createDocumentsApi } from "./documents-api"
import { server } from "./server"

/**
 * gherkin/apply-anyway.feature AA-7.4 (CR-AA-06): the mock create handler
 * decides from the stored posting and the acknowledgement, never from a list
 * of ranked ids. Each Examples row is one case.
 */

const rule = (violated: string[]) =>
  (["location", "sponsorship", "pay", "hours", "industry"] as const).map((r) => ({ rule: r, result: violated.includes(r) ? ("violated" as const) : ("met" as const), quote: null }))

function setup(posting: ReturnType<typeof rankedPosting>) {
  const discovery = createDiscoveryApi({ postings: [posting] })
  const documents = createDocumentsApi()
  linkFakes(discovery, documents)
  server.use(...discovery.handlers, ...documents.handlers)
  return documents
}

async function create(body: unknown) {
  const response = await fetch(new URL("/v1/applications", window.location.origin), {
    method: "POST",
    headers: { "content-type": "application/json", [CSRF_HEADER]: TEST_CSRF_TOKEN },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json()) as { application?: { override: unknown }; error?: { code: string; message: string } } }
}

const weak = { status: "skipped", skipReason: "weak_core_match", skipDetail: null, violatedRules: [] } as const

afterEach(() => server.resetHandlers())

describe("AA-7.4: the mock create handler decides from the posting and the acknowledgement", () => {
  it("ranked, no acknowledgement: created with a null override", async () => {
    const posting = rankedPosting()
    setup(posting)
    const { status, json } = await create({ jobPostingId: posting.id })
    expect(status).toBe(201)
    expect(json.application?.override).toBeNull()
  })

  it("weak core Match, matching acknowledgement: created with an override", async () => {
    const posting = rankedPosting({ status: "skipped", rank: null, skipReason: "weak_core_match" })
    setup(posting)
    const { status, json } = await create({ jobPostingId: posting.id, acknowledgement: { confirmed: true, decision: weak } })
    expect(status).toBe(201)
    expect(json.application?.override).toMatchObject({ ...weak, applies: true, notAppliesReason: null })
  })

  it("weak core Match, no acknowledgement: 409 C-AA-12", async () => {
    const posting = rankedPosting({ status: "skipped", rank: null, skipReason: "weak_core_match" })
    setup(posting)
    const { status, json } = await create({ jobPostingId: posting.id })
    expect(status).toBe(409)
    expect(json.error?.message).toBe(APPLY_ANYWAY_ERROR_MESSAGES.override_acknowledgement_missing)
  })

  it("weak core Match, acknowledgement for no_core_responsibilities: 409 C-AA-9", async () => {
    const posting = rankedPosting({ status: "skipped", rank: null, skipReason: "weak_core_match" })
    setup(posting)
    const { status, json } = await create({ jobPostingId: posting.id, acknowledgement: { confirmed: true, decision: { ...weak, skipReason: "no_core_responsibilities" } } })
    expect(status).toBe(409)
    expect(json.error?.message).toBe(APPLY_ANYWAY_ERROR_MESSAGES.override_decision_changed)
  })

  it("excluded for location, matching acknowledgement: 409 C-AA-10", async () => {
    const base = rankedPosting({ status: "excluded", rank: null, skipReason: "violated_rule", skipDetail: "location" })
    const posting = { ...base, eligibility: { ...base.eligibility!, rules: rule(["location"]) } }
    setup(posting)
    const decision = { status: "excluded", skipReason: "violated_rule", skipDetail: "location", violatedRules: ["location"] }
    const { status, json } = await create({ jobPostingId: posting.id, acknowledgement: { confirmed: true, decision } })
    expect(status).toBe(409)
    expect(json.error?.message).toBe(APPLY_ANYWAY_ERROR_MESSAGES.override_not_allowed)
  })

  it("hidden, matching acknowledgement: 409 posting_hidden", async () => {
    const posting = rankedPosting({ status: "skipped", rank: null, skipReason: "weak_core_match", hiddenReason: "off_target" })
    setup(posting)
    const { status, json } = await create({ jobPostingId: posting.id, acknowledgement: { confirmed: true, decision: weak } })
    expect(status).toBe(409)
    expect(json.error?.code).toBe("posting_hidden")
  })

  it("the posting detail offers applyAnyway from the same store", async () => {
    const posting = rankedPosting({ status: "skipped", rank: null, skipReason: "weak_core_match" })
    setup(posting)
    const detail = (await (await fetch(new URL(`/v1/job-postings/${posting.id}`, window.location.origin))).json()) as { applyAnyway: unknown; applicationId: unknown }
    expect(detail).toMatchObject({ applyAnyway: { offered: true, decision: weak }, applicationId: null })
  })
})
