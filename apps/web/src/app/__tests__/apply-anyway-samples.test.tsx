import { screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { awaitingSample, rankedPosting, submissionStatus } from "@/shared/testing"
import { entry, openSubmission } from "./submission-helpers"

/**
 * gherkin/apply-anyway.feature AA-3.2 (frontend rows): the sample result after
 * an approval whose posting stopped being ranked (`not_ranked`, C-AA-36) or
 * whose Application has an override (`not_allowed`, C-AA-37 as the contract
 * suggests; note 4 of the responsibility map), each followed by C-SAMPLE-10.
 * `excluded` keeps C-SAMPLE-3. Mocked component checks.
 */

const DOESNT_COUNT = "This sample doesn't count toward the 5 because it wasn't submitted. 2 of 5 samples approved."

function approveSample(result: "not_ranked" | "not_allowed" | "excluded") {
  const posting = rankedPosting({ status: "skipped", rank: null, skipReason: "weak_core_match", company: "Initech" })
  const app = entry(awaitingSample(), { jobPostingId: posting.id, company: "Initech", requisitionId: "R-4205" })
  const opened = openSubmission(`/activation/${app.app.id}`, [app], { status: submissionStatus({ countingSamples: 2 }) }, { postings: [posting] })
  opened.api.state.nextSampleResult = () => ({ result, submission: {} })
  return { ...opened, id: app.app.id }
}

async function approve(user: ReturnType<typeof openSubmission>["user"]) {
  await user.click(await screen.findByRole("button", { name: "Approve and submit" }))
  await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Approve and submit" }))
}

describe("AA-3.2: sample results for a posting that is no longer ranked", () => {
  it("not_ranked: C-AA-36 then C-SAMPLE-10; nothing counts", async () => {
    const { user, api, id } = approveSample("not_ranked")
    await approve(user)
    expect(await screen.findByText("Not submitted. This Job Posting isn't ranked any more, so nothing was sent.")).toBeVisible()
    expect(screen.getByText(DOESNT_COUNT)).toBeVisible()
    expect(api.state.status.countingSamples).toBe(2)
    expect(api.state.submissions[id]).toMatchObject({ state: "not_submitted", sample: { state: "approved", counts: false } })
  })

  it("not_allowed (override recorded): C-AA-37 then C-SAMPLE-10; nothing counts", async () => {
    const { user, api } = approveSample("not_allowed")
    await approve(user)
    expect(
      await screen.findByText("An Application with an override, or for a Job Posting that isn't ranked, can't be an Activation Gate sample. Nothing changed.")
    ).toBeVisible()
    expect(screen.getByText(DOESNT_COUNT)).toBeVisible()
    expect(api.state.status.countingSamples).toBe(2)
  })

  it("excluded keeps C-SAMPLE-3a / C-SAMPLE-3 and not C-AA-36", async () => {
    const { user } = approveSample("excluded")
    await approve(user)
    expect(await screen.findByText(/^Not submitted\. This Job Posting (has a violated|breaks one of your) Eligibility rule/)).toBeVisible()
    expect(screen.queryByText("Not submitted. This Job Posting isn't ranked any more, so nothing was sent.")).not.toBeInTheDocument()
  })
})
