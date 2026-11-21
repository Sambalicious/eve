import { addedFactsViewSchema, applicationDetailSchema } from "@eve/contracts"
import { describe, expect, it } from "vitest"

import { ADDED_FACTS_STATES, applicationWithAddedFacts, editableWithFacts, freshLifted } from "./added-facts-fixtures"

/** FEAT-0017 QA gate: every named MSW state must be accepted by the strict contract schema the api answers with. */
describe("added-facts fixtures match the strict contract schemas", () => {
  it.each(Object.entries(ADDED_FACTS_STATES))("%s parses as an AddedFactsView", (_name, build) => {
    expect(addedFactsViewSchema.safeParse(build()).success).toBe(true)
  })

  it("editableWithFacts and freshLifted cite frozen used-facts, not whole facts", () => {
    for (const view of [editableWithFacts(), freshLifted()]) {
      for (const cited of view.addedFactsCited) expect(Object.keys(cited).sort()).toEqual(["id", "kind", "role", "text"])
    }
  })

  it("an ApplicationDetail carrying a view parses", () => {
    expect(applicationDetailSchema.safeParse(applicationWithAddedFacts()).success).toBe(true)
  })
})
