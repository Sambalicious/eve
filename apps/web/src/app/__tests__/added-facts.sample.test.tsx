import { screen, within } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import type { AddedFactUsed } from "@eve/contracts"

import { addedFactsView, applicationWithAddedFacts, FIGMA_FACT_ID, skillOnlyFact } from "@/shared/testing/added-facts-fixtures"
import { awaitingSample, server, submission, tailoredDocument } from "@/shared/testing"
import { openDocuments } from "./documents-helpers"

function openSample(cited: readonly AddedFactUsed[], documentsStale = false) {
  const view = addedFactsView({
    version: 1,
    facts: [skillOnlyFact()],
    counts: { oneLiner: 0, skillOnly: 1 },
    addedFactsCited: [...cited],
    documentsStale,
  })
  const app = applicationWithAddedFacts(view, {
    documents: [{ ...tailoredDocument(view.facts[0]!.id, "resume"), ats: { score: 62, total: 9, matched: ["React"], missing: [], gaps: [] } }],
  })
  server.use(http.get("/v1/applications/:id/submission", () => HttpResponse.json(submission(awaitingSample()))))
  openDocuments(`/activation/${app.id}`, { applications: [app] })
  return app
}

const CITED: readonly AddedFactUsed[] = [{ id: FIGMA_FACT_ID, kind: "skill_only", text: "Figma", role: null }]

describe("FEAT-0017 Activation Gate sample: the added-skills marker (OD-16, AC 7.9)", () => {
  it("a sample whose documents cite added facts is marked and lists them read-only", async () => {
    const app = openSample(CITED)
    expect(await screen.findByText("Added skills used")).toBeVisible()
    const list = await screen.findByRole("region", { name: "Added facts in this sample" })
    expect(within(list).getByText("Figma")).toBeVisible()
    expect(within(list).getByText("skill only")).toBeVisible()
    expect(within(list).getByRole("link", { name: "Edit on the Application page" })).toHaveAttribute(
      "href",
      `/applications/${app.id}#added-facts`
    )
  })

  it("a sample with added facts its documents do not cite is not marked", async () => {
    openSample([])
    expect(await screen.findByRole("heading", { level: 1 })).toBeVisible()
    expect(screen.queryByText("Added skills used")).not.toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "Added facts in this sample" })).not.toBeInTheDocument()
  })

  it("@ac-7.9 when the facts changed while waiting, C-AF-88 asks for a new review", async () => {
    openSample(CITED, true)
    expect(await screen.findByText("The facts changed, so this sample needs a new review.")).toBeVisible()
  })
})
