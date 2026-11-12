import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { GENERATING, IN_FLIGHT, PENDING_DECISION, PENDING_SAMPLE, isBusy } from "./details-deletion.js"

/** Architecture R2: one deletion code path. The manual endpoint and the job hold no copy of the deletes. */
describe("shared deletion of detailed records (PRD E2.1, E3.5, E3.6)", () => {
  const read = (file: string) => readFileSync(join(import.meta.dirname, file), "utf8")

  it.each(["records.service.ts", "retention-runner.ts"])("%s deletes no detail table and clears no detail column itself", (file) => {
    const source = read(file)
    expect(source).not.toMatch(/deleteFrom\("(tailored_document|application_form_read|outcome|notification_outbox|submission_event|outreach_message)"\)/)
    expect(source).not.toMatch(/role_title:\s*null/)
    expect(source).toMatch(/deleteDetailsLocked\(/)
  })

  it("the busy set is the manual 409 set: generating, submit_claimed, submitting", () => {
    expect(GENERATING).toBe("generating")
    expect(IN_FLIGHT).toEqual(["submit_claimed", "submitting"])
    expect(isBusy({ state: "generating", submission_state: null })).toBe(true)
    expect(isBusy({ state: "documents_ready", submission_state: "submit_claimed" })).toBe(true)
    expect(isBusy({ state: "documents_ready", submission_state: "submitting" })).toBe(true)
    for (const submission of [null, "queued", "uncertain", "blocked", "confirmed", "failed"]) expect(isBusy({ state: "documents_ready", submission_state: submission })).toBe(false)
  })

  it("D-E9: pending decisions are Uncertain, Blocked, queued and a sample awaiting review", () => {
    expect(PENDING_DECISION).toEqual(["uncertain", "blocked", "queued"])
    expect(PENDING_SAMPLE).toBe("awaiting_review")
  })
})
