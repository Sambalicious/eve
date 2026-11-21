import { describe, expect, it } from "vitest"

import { ApiError } from "@/shared/api"

import { addedFactFieldErrors } from "./added-facts-actions"

describe("FEAT-0017 field errors", () => {
  it("keeps the added_facts members of the envelope's union and drops the rest", () => {
    const error = new ApiError(422, "added_facts_invalid", "Check the highlighted fields. Nothing was saved.", null, [], [
      { source: "added_facts", field: "text", position: 1, problem: "empty" },
      { code: "job_title_required", field: "jobTitle" },
    ] as never)
    expect(addedFactFieldErrors(error)).toEqual([{ source: "added_facts", field: "text", position: 1, problem: "empty" }])
  })
})
