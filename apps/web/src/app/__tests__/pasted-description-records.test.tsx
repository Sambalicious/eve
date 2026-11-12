import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { JobPostingDetail } from "@eve/contracts"
import { pastedPosting, rankedPosting, readyApplication, strongMatch, submission } from "@/shared/testing"
import { openDiscovery } from "./discovery-helpers"
import { openDocuments } from "./documents-helpers"
import { entry, openSubmission } from "./submission-helpers"

/**
 * gherkin/pasted-description-evaluation.feature, pasted-description-documents.feature,
 * manual-only.feature and paste-description.feature (PD-1.7): the frontend and
 * "both" rows of gherkin-responsibility.md for the posting list, posting detail,
 * Application detail, Applications and Documents (design r1 B2 to B4). Mocked
 * component checks against the contract-derived fakes (api-contract.md v1.27.0).
 */

const C_PD_41 = "You pasted this text. Eve didn't read the employer's page."
const C_PD_42 = "Eve wouldn't apply to this job by itself."
const C_PD_43 = "You can still prepare documents and apply yourself."
const C_PD_44 = "It breaks these rules:"
const C_PD_51 = "Pasted, manual only"
const C_PD_60 = "Eve never sends this one. You apply yourself."
const C_PD_61 = "Download the resume and cover letter, then apply on the employer's site. It isn't queued or counted in the daily cap."
const C_PD_62 = "Download the resume and cover letter, then apply wherever you found the job. It isn't queued or counted in the daily cap."
const C_PD_63 = "The documents are here if you decide to apply anyway."
const LINK = "https://careers.paystack.com/jobs/42"

const rules = (results: Partial<Record<string, "violated" | "unverified" | "met">>) =>
  (["location", "sponsorship", "pay", "hours", "industry"] as const).map((rule) => ({ rule, result: results[rule] ?? ("met" as const), quote: null }))

function excludedPasted(o: Partial<JobPostingDetail> = {}) {
  const base = pastedPosting({ status: "excluded", rank: null, skipReason: "violated_rule", skipDetail: "location", ...o })
  return { ...base, eligibility: base.eligibility && { ...base.eligibility, rules: rules({ location: "violated", pay: "violated", hours: "unverified" }) } }
}

const skippedPasted = (o: Partial<JobPostingDetail> = {}) =>
  pastedPosting({
    status: "skipped",
    rank: null,
    skipReason: "weak_core_match",
    match: { ...strongMatch(), verdict: "weak", weakReason: "coverage_below_threshold", coveredCount: 6, totalCount: 10, thresholdPercent: 70 },
    ...o,
  })

const heading = () => screen.findByRole("heading", { level: 1, name: /Senior Frontend Engineer/ })

describe("PD-2.5 lists: never hidden, under its decision, with the Pasted mark (EV:149, EV:162)", () => {
  it("a ranked pasted posting is on the Good matches tab with Pasted and no Manual Application badge", async () => {
    openDiscovery("/postings?tab=good", { postings: [pastedPosting({ title: "Pasted Lead" })] })
    const row = (await screen.findAllByRole("link", { name: /^Pasted Lead at/ }))[0].closest("tr, li") as HTMLElement
    expect(within(row).getByText("Pasted")).toBeVisible()
    expect(within(row).queryByText("Manual Application")).not.toBeInTheDocument()
  })

  it("DR-04 (design r2 B4) the Application system cell is empty without a link, never the synthetic 'none'", async () => {
    openDiscovery("/postings?tab=good", {
      postings: [pastedPosting({ title: "Pasted Lead", rank: 1 }), rankedPosting({ title: "Linked Lead", rank: 2 })],
    })
    const table = await screen.findByRole("table")
    const header = within(table).getAllByRole("columnheader").map((h) => h.textContent)
    const col = header.findIndex((t) => t === "Application System")
    expect(col).toBeGreaterThan(-1)
    const rowOf = async (name: RegExp) => (await within(table).findByRole("link", { name })).closest("tr") as HTMLElement
    expect(within(await rowOf(/^Pasted Lead at/)).getAllByRole("cell")[col]).toHaveTextContent(/^$/)
    expect(within(await rowOf(/^Linked Lead at/)).getAllByRole("cell")[col]).toHaveTextContent("Greenhouse")
    expect(within(table).queryByText("none")).not.toBeInTheDocument()
  })

  it("a skipped pasted posting is listed on Skipped by rules with the mark", async () => {
    openDiscovery("/postings?tab=not_a_match", { postings: [skippedPasted({ title: "Pasted Skip" })] })
    const row = (await screen.findAllByRole("link", { name: /^Pasted Skip at/ }))[0].closest("tr, li") as HTMLElement
    expect(within(row).getByText("Pasted")).toBeVisible()
  })

  it("a pasted_link posting carries no Pasted mark", async () => {
    openDiscovery("/postings?tab=good", { postings: [rankedPosting({ title: "Linked Role", origin: "pasted_link" })] })
    const row = (await screen.findAllByRole("link", { name: /^Linked Role at/ }))[0].closest("tr, li") as HTMLElement
    expect(within(row).queryByText("Pasted")).not.toBeInTheDocument()
  })
})

describe("PD-2.1, PD-1.7 posting detail of a pasted-description posting (EV:39, EV:47, PD:301, PD:315)", () => {
  it("EV:39 shows Pasted and the text note; hides the synthetic Requisition ID, Application system and employer link without a link", async () => {
    const p = pastedPosting()
    openDiscovery(`/postings/${p.id}`, { postings: [p] })
    await heading()
    expect(screen.getByText("Pasted")).toBeVisible()
    expect(screen.queryByText("Manual Application")).not.toBeInTheDocument()
    expect(screen.getByText(C_PD_41)).toBeVisible()
    expect(screen.queryByText("Requisition ID")).not.toBeInTheDocument()
    expect(screen.queryByText(p.requisitionId)).not.toBeInTheDocument()
    expect(screen.queryByText("Application system")).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /Open employer page/ })).not.toBeInTheDocument()
  })

  it("with a link, the employer link and Application system show; the requisition stays hidden", async () => {
    const p = pastedPosting({ applicationUrl: LINK, applyUrl: LINK, applicationSystem: "careers.paystack.com" })
    openDiscovery(`/postings/${p.id}`, { postings: [p] })
    await heading()
    expect(screen.getByRole("link", { name: /Open employer page/ })).toHaveAttribute("href", LINK)
    expect(screen.getByText("careers.paystack.com")).toBeVisible()
    expect(screen.queryByText(p.requisitionId)).not.toBeInTheDocument()
  })

  it("EV:47 a pasted_link posting shows no note and no Pasted mark", async () => {
    const p = rankedPosting({ origin: "pasted_link" })
    openDiscovery(`/postings/${p.id}`, { postings: [p] })
    await heading()
    expect(screen.queryByText(C_PD_41)).not.toBeInTheDocument()
    expect(screen.queryByText("Pasted")).not.toBeInTheDocument()
    expect(screen.getByText("R-1042")).toBeVisible()
  })

  it("PD:301 / PD:315 markup is literal text and line breaks are kept", async () => {
    const text = "Senior Frontend Engineer\n<script>alert(1)</script>\n**bold** <b>not bold</b>"
    const p = pastedPosting({ postingText: text })
    const { container } = openDiscovery(`/postings/${p.id}`, { postings: [p] })
    await heading()
    const body = screen.getByText((_, el) => el?.tagName === "P" && el.textContent === text)
    expect(body).toHaveClass("whitespace-pre-line")
    expect(container.querySelector("script, b")).toBeNull()
  })
})

describe("PD-3.1, PD-4.3 Prepare documents and the warning on a pasted posting (DOC:25, DOC:59, MO:123, MO:138, MO:153, MO:160)", () => {
  it.each([
    ["ranked", () => pastedPosting()],
    ["skipped", () => skippedPasted()],
    ["excluded", () => excludedPasted()],
  ])("DOC:25 / MO:138 a %s pasted posting offers Prepare documents with no dialog; the create sends no acknowledgement", async (_, make) => {
    const p = make()
    const { user, api } = openDocuments(`/postings/${p.id}`, {}, { discovery: { postings: [p] } })
    await heading()
    await user.click(screen.getByRole("button", { name: "Prepare documents for Senior Frontend Engineer at Paystack" }))
    await waitFor(() => expect(api.requests.filter((r) => r.method === "POST" && r.path === "/v1/applications")).toHaveLength(1))
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    expect(api.requests.find((r) => r.path === "/v1/applications")?.body).toEqual({ jobPostingId: p.id })
    expect(api.state.applications[0]).toMatchObject({ pastedDescription: true, manualOnly: true, override: null })
    expect(screen.queryByRole("button", { name: /Prepare documents anyway/ })).not.toBeInTheDocument()
  })

  it.each(["checking", "waiting_to_be_checked", "evaluation_failed"] as const)("DOC:59 no create action while %s", async (status) => {
    const p = pastedPosting({ status, rank: null, eligibility: null, match: null, evaluationFailure: status === "evaluation_failed" ? "provider_error" : null })
    openDiscovery(`/postings/${p.id}`, { postings: [p] })
    await heading()
    expect(screen.queryByRole("button", { name: /Prepare documents/ })).not.toBeInTheDocument()
  })

  it("MO:123 a skipped pasted posting warns with the reason line and C-PD-43; Prepare documents is described by the warning", async () => {
    const p = skippedPasted()
    openDiscovery(`/postings/${p.id}`, { postings: [p] })
    await heading()
    const title = screen.getByText(C_PD_42)
    const panel = title.closest("[data-slot=alert]") as HTMLElement
    expect(panel).not.toHaveAttribute("role")
    expect(panel).toHaveTextContent("Your profile backs only 60% of the core responsibilities. Your minimum is 70%.")
    expect(panel).toHaveTextContent(C_PD_43)
    expect(screen.getByRole("button", { name: /Prepare documents/ })).toHaveAccessibleDescription(C_PD_42)
    // One panel, not two: the reason alert is replaced.
    expect(screen.getAllByText("Your profile backs only 60% of the core responsibilities. Your minimum is 70%.")).toHaveLength(1)
  })

  it("MO:123 / MO:153 an excluded pasted posting names each violated rule and never an unverified one", async () => {
    const p = excludedPasted()
    openDiscovery(`/postings/${p.id}`, { postings: [p] })
    await heading()
    const panel = screen.getByText(C_PD_42).closest("[data-slot=alert]") as HTMLElement
    expect(within(panel).getByText(C_PD_44)).toBeVisible()
    expect(within(panel).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Location", "Pay"])
    expect(panel).toHaveTextContent(C_PD_43)
  })

  it("MO:160 a ranked pasted posting shows no warning", async () => {
    const p = pastedPosting()
    openDiscovery(`/postings/${p.id}`, { postings: [p] })
    await heading()
    expect(screen.queryByText(C_PD_42)).not.toBeInTheDocument()
  })

  it("DOC:202 a double click creates one Application", async () => {
    const p = pastedPosting()
    const { user, api } = openDocuments(`/postings/${p.id}`, {}, { discovery: { postings: [p] } })
    await heading()
    await user.dblClick(screen.getByRole("button", { name: /Prepare documents/ }))
    await waitFor(() => expect(api.state.applications).toHaveLength(1))
    expect(api.requests.filter((r) => r.method === "POST" && r.path === "/v1/applications")).toHaveLength(1)
  })
})

describe("PD-4.1, PD-4.3, PD-4.4 Application detail of a pasted Application (MO:75, MO:147, MO:170)", () => {
  const pastedApp = (p: JobPostingDetail, o: Parameters<typeof readyApplication>[0] = {}) =>
    readyApplication({
      jobPostingId: p.id,
      company: p.company,
      roleTitle: p.title,
      requisitionId: p.requisitionId,
      applicationUrl: p.applicationUrl,
      pastedDescription: true,
      manualOnly: true,
      ...o,
    })

  it("MO:170 / MO:75 shows C-PD-51, the manual-only notice without a link (C-PD-62), no requisition, no queue or sample actions", async () => {
    const p = pastedPosting({ applicationId: null })
    const app = pastedApp(p)
    openSubmission(`/applications/${app.id}`, [entry(submission({ state: null, kind: null }), app)], {}, { postings: [p] })
    await heading()
    expect(screen.getByText(C_PD_51)).toBeVisible()
    expect(screen.queryByText("Override")).not.toBeInTheDocument()
    expect(screen.getByText(C_PD_60)).toBeVisible()
    expect(screen.getByText(C_PD_62)).toBeVisible()
    expect(screen.queryByRole("link", { name: /Open employer page/ })).not.toBeInTheDocument()
    expect(screen.queryByText(app.requisitionId)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /queue|sample|approve/i })).not.toBeInTheDocument()
  })

  it("with a link the notice says C-PD-61 and links to the employer's page", async () => {
    const p = pastedPosting({ applicationUrl: LINK, applyUrl: LINK })
    const app = pastedApp(p)
    openSubmission(`/applications/${app.id}`, [entry(submission({ state: null, kind: null }), app)], {}, { postings: [p] })
    await heading()
    expect(screen.getByText(C_PD_61)).toBeVisible()
    expect(screen.getAllByRole("link", { name: /Open employer page/ })[0]).toHaveAttribute("href", LINK)
  })

  it("MO:147 an excluded pasted posting's Application repeats the warning with its rules and C-PD-63", async () => {
    const p = excludedPasted()
    const app = pastedApp(p)
    openSubmission(`/applications/${app.id}`, [entry(submission({ state: null, kind: null }), app)], {}, { postings: [p] })
    await heading()
    const panel = (await screen.findByText(C_PD_42)).closest("[data-slot=alert]") as HTMLElement
    expect(within(panel).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Location", "Pay"])
    expect(panel).toHaveTextContent(C_PD_63)
    expect(panel).not.toHaveTextContent(C_PD_43)
  })

  it("MO:160 a ranked pasted posting's Application shows no warning", async () => {
    const p = pastedPosting()
    const app = pastedApp(p)
    openSubmission(`/applications/${app.id}`, [entry(submission({ state: null, kind: null }), app)], {}, { postings: [p] })
    await heading()
    await screen.findByText(C_PD_60)
    expect(screen.queryByText(C_PD_42)).not.toBeInTheDocument()
  })

  it("DR-03 (design r2 B3) a manual-only Application has no Answers used card; a normal one keeps it", async () => {
    const p = pastedPosting()
    const app = pastedApp(p)
    openSubmission(`/applications/${app.id}`, [entry(submission({ state: null, kind: null }), app)], {}, { postings: [p] })
    await heading()
    await screen.findByText(C_PD_60)
    expect(screen.queryByRole("heading", { name: "Answers used" })).not.toBeInTheDocument()
    expect(document.getElementById("answers")).toBeNull()
  })

  it("DR-03 control: a normal Application still shows Answers used", async () => {
    const normal = readyApplication()
    openSubmission(`/applications/${normal.id}`, [entry(submission({ state: null, kind: null }), normal)])
    await heading()
    expect(await screen.findByRole("heading", { name: "Answers used" })).toBeVisible()
  })
})

describe("PD-4.4 Applications and Documents lists (MO:170, MO:182)", () => {
  it("MO:170 a pasted Application shows C-PD-51 and no synthetic requisition; MO:182 a normal one shows neither mark", async () => {
    const pasted = readyApplication({ roleTitle: "Pasted Role", requisitionId: "pasted:abc", applicationUrl: null, pastedDescription: true, manualOnly: true })
    const normal = readyApplication({ roleTitle: "Normal Role" })
    openDocuments("/applications?view=list", { applications: [pasted, normal] })
    await screen.findAllByText(/Pasted Role/)
    expect(screen.getAllByText(C_PD_51).length).toBeGreaterThan(0)
    expect(screen.queryByText("pasted:abc")).not.toBeInTheDocument()
    expect(screen.getAllByText("R-1042").length).toBeGreaterThan(0)
    for (const row of screen.getAllByText(/Normal Role/).map((el) => el.closest("tr, li") as HTMLElement)) {
      expect(within(row).queryByText(C_PD_51)).not.toBeInTheDocument()
    }
  })

  it("the Documents page marks a pasted Application with C-PD-51 instead of its requisition", async () => {
    const pasted = readyApplication({ roleTitle: "Pasted Role", requisitionId: "pasted:abc", applicationUrl: null, pastedDescription: true, manualOnly: true })
    openDocuments("/documents", { applications: [pasted] })
    await screen.findAllByText(/Pasted Role/)
    expect(screen.getAllByText(C_PD_51).length).toBeGreaterThan(0)
    expect(screen.queryByText("pasted:abc")).not.toBeInTheDocument()
  })
})
