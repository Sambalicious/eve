import { screen, waitFor, within } from "@testing-library/react"
import { http } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { JobPostingDetail } from "@eve/contracts"
import { apiErrorResponse, rankedPosting, readyApplication, server, strongMatch, submission, tailoredDocument, TEST_CSRF_TOKEN } from "@/shared/testing"
import { advance, findToast } from "./career-setup-helpers"
import { openDocuments } from "./documents-helpers"

const created: Blob[] = []
beforeEach(() => {
  created.length = 0
  // jsdom has no object URLs; record what the preview turned into one.
  URL.createObjectURL = vi.fn((blob: Blob) => {
    created.push(blob)
    return `blob:http://localhost/${created.length}`
  })
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  // @ts-expect-error restore jsdom's absence
  delete URL.createObjectURL
  // @ts-expect-error restore jsdom's absence
  delete URL.revokeObjectURL
})

function documentsRegion() {
  return screen.findByRole("region", { name: "Documents" })
}

describe("Application detail: header and evidence (slice 4 parts)", () => {
  it("shows the name, Draft, Profile version, requisition, employment type, Eligibility and Match", async () => {
    const posting = rankedPosting({ match: strongMatch(), unverifiedLabels: ["hours"] })
    const app = readyApplication({ jobPostingId: posting.id })
    openDocuments(`/applications/${app.id}`, { applications: [app] }, { discovery: { postings: [posting] } })

    expect(await screen.findByRole("heading", { level: 1, name: "Senior Frontend Engineer at Acme Payments" })).toBeVisible()
    expect(document.title).toBe("Senior Frontend Engineer at Acme Payments · Eve")
    expect(screen.getByText("Draft")).toBeVisible()
    expect(screen.getByText("Profile version 1")).toBeVisible()
    expect(screen.getByText("R-1042")).toBeVisible()
    expect(await screen.findByText("Direct employment")).toBeVisible()
    expect(screen.getByText("Unverified: hours")).toBeVisible()
    expect(await screen.findByRole("region", { name: "Eligibility" })).toBeVisible()
    expect(screen.getByRole("region", { name: "Match" })).toBeVisible()
    expect(screen.getByRole("link", { name: /Open employer page/ })).toHaveAttribute("href", app.applicationUrl)
  })

  it("an Application not yet in submission shows no Evidence; slice 7 adds the Answers table and Outcomes (C-OUT-1)", async () => {
    const app = readyApplication()
    openDocuments(`/applications/${app.id}`, { applications: [app] })

    await documentsRegion()
    expect(screen.queryByRole("region", { name: "Evidence" })).not.toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Evidence" })).not.toBeInTheDocument()
    expect(await screen.findByRole("heading", { level: 2, name: "Answers used" })).toHaveAttribute("id", "answers")
    const outcomes = await screen.findByRole("region", { name: "Outcomes" })
    expect(await within(outcomes).findByText("No Outcomes yet.")).toBeVisible()
  })

  it("an unknown id shows C-ERR-3 with Back to Applications", async () => {
    openDocuments("/applications/30000000-0000-4000-8000-999999999999")

    expect(await screen.findByRole("heading", { name: "Not found" })).toBeVisible()
    expect(screen.getByText("This Application doesn't exist or its records were cleared.")).toBeVisible()
    expect(screen.getByRole("link", { name: "Back to Applications" })).toHaveAttribute("href", "/applications")
  })
})

describe("Application detail: ATS match", () => {
  it("shows the resume's ATS score, its keywords, and the gaps with a link to the Career Profile", async () => {
    const base = readyApplication()
    const resume = { ...tailoredDocument(base.id, "resume"), ats: { score: 50, total: 6, matched: ["React", "TypeScript", "Git"], missing: [], gaps: ["GraphQL", "Docker / Kubernetes"] } }
    const app = { ...base, documents: [resume, tailoredDocument(base.id, "cover_letter")] }
    openDocuments(`/applications/${app.id}`, { applications: [app] })
    const card = (await screen.findByRole("heading", { level: 4, name: "ATS match 50%" })).closest("section")!
    expect(within(card).getByText("4 of 6 requirements from this posting")).toBeVisible()
    expect(within(card).getByText(/React, TypeScript, Git/)).toBeVisible()
    expect(within(card).getByText(/GraphQL, Docker \/ Kubernetes/)).toBeVisible()
    expect(within(card).getByRole("link", { name: "add it to your Career Profile" })).toHaveAttribute("href", "/profile")
  })

  it("shows no ATS card for a resume written before ATS scoring", async () => {
    const app = readyApplication()
    openDocuments(`/applications/${app.id}`, { applications: [app] })
    await documentsRegion()
    expect(screen.queryByText(/ATS match/)).not.toBeInTheDocument()
  })
})

describe("Application detail: Generate again on ready documents", () => {
  it("offers Generate again while the Application has not entered submission", async () => {
    const app = readyApplication()
    openDocuments(`/applications/${app.id}`, { applications: [app] })
    await documentsRegion()
    expect(await screen.findByRole("button", { name: "Generate again" })).toBeVisible()
  })

  it("offers no Generate again once submission has started", async () => {
    const app = readyApplication()
    openDocuments(`/applications/${app.id}`, { applications: [app] })
    server.use(http.get("/v1/applications/:id/submission", () => Response.json(submission({ state: "queued", kind: "automatic" }))))
    await documentsRegion()
    await screen.findByRole("heading", { level: 2, name: "Answers used" })
    expect(screen.queryByRole("button", { name: "Generate again" })).not.toBeInTheDocument()
  })
})

describe("Application detail: Documents viewer (F5)", () => {
  it("Resume tab: inline PDF preview from a blob: URL of the authenticated download, and both downloads", async () => {
    const app = readyApplication()
    openDocuments(`/applications/${app.id}`, { applications: [app] })

    const region = await documentsRegion()
    expect(within(region).getByRole("tab", { name: "Resume" })).toHaveAttribute("aria-selected", "true")
    const frame = await within(region).findByTitle("Resume, Senior Frontend Engineer at Acme Payments")
    expect(frame.tagName).toBe("IFRAME")
    expect(frame).toHaveAttribute("src", "blob:http://localhost/1")
    expect(created[0].type).toBe("application/pdf")
    expect(await created[0].text()).toMatch(/^%PDF-/)
    expect(within(region).getByRole("link", { name: "Download PDF, Resume" })).toHaveAttribute(
      "href",
      `/v1/applications/${app.id}/documents/resume.pdf`
    )
    expect(within(region).getByRole("link", { name: "Download DOCX, Resume" })).toHaveAttribute(
      "href",
      `/v1/applications/${app.id}/documents/resume.docx`
    )
    // The text version is plain text from the contract's previewText.
    expect(within(region).getByText("Built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd")).toBeInTheDocument()
  })

  it("a preview that can't load shows C-DOC-16 with Try again, and the downloads stay", async () => {
    const app = readyApplication()
    openDocuments(`/applications/${app.id}`, { applications: [app] })
    server.use(http.get("/v1/applications/:id/documents/resume.pdf", () => apiErrorResponse("internal_error")))

    const region = await documentsRegion()
    expect(await within(region).findByRole("alert")).toHaveTextContent("The preview couldn't load. The downloads below still work.")
    expect(within(region).getByRole("button", { name: "Try again" })).toBeVisible()
    expect(within(region).getByRole("link", { name: "Download PDF, Resume" })).toBeVisible()
  })

  it("revokes the preview's blob: URL when leaving the page", async () => {
    const app = readyApplication()
    const { user } = openDocuments(`/applications/${app.id}`, { applications: [app] })

    await within(await documentsRegion()).findByTitle(/^Resume,/)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    await user.click(screen.getByRole("link", { name: "Jobs" }))

    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/1"))
  })

  it("Cover letter tab shows its own preview and downloads, and no upload line before submission", async () => {
    const app = readyApplication()
    const { user } = openDocuments(`/applications/${app.id}`, { applications: [app] })

    const region = await documentsRegion()
    await user.click(within(region).getByRole("tab", { name: "Cover letter" }))

    expect(await within(region).findByTitle("Cover letter, Senior Frontend Engineer at Acme Payments")).toBeVisible()
    expect(within(region).getByRole("link", { name: "Download PDF, Cover letter" })).toHaveAttribute(
      "href",
      `/v1/applications/${app.id}/documents/cover-letter.pdf`
    )
    expect(within(region).queryByText("Uploaded with the Application.")).not.toBeInTheDocument()
    expect(within(region).queryByText(/^Not uploaded\./)).not.toBeInTheDocument()
  })

  it.each([
    ["uploaded", "Uploaded with the Application."],
    ["no_field", "Not uploaded. The form had no cover letter field. Stored here for your records."],
  ] as const)("cover letter status %s shows its line (C-DOC-1 / C-DOC-2)", async (coverLetterStatus, line) => {
    const app = readyApplication({ coverLetterStatus })
    const { user } = openDocuments(`/applications/${app.id}`, { applications: [app] })

    const region = await documentsRegion()
    await user.click(within(region).getByRole("tab", { name: "Cover letter" }))
    expect(await within(region).findByText(line)).toBeVisible()
  })

  it("#cover-letter opens the Cover letter tab and focuses its heading", async () => {
    const app = readyApplication()
    openDocuments(`/applications/${app.id}#cover-letter`, { applications: [app] })

    const region = await documentsRegion()
    expect(within(region).getByRole("tab", { name: "Cover letter" })).toHaveAttribute("aria-selected", "true")
    await waitFor(() => expect(within(region).getByRole("heading", { level: 3, name: "Cover letter" })).toHaveFocus())
  })

  it("never renders document HTML: the text version shows markup as text", async () => {
    const app = readyApplication()
    app.documents = [{ ...tailoredDocument(app.id, "resume"), previewText: ['<img src=x onerror="alert(1)">', "<b>Bold</b>"] }]
    openDocuments(`/applications/${app.id}`, { applications: [app] })

    const region = await documentsRegion()
    expect(within(region).getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument()
    expect(region.querySelector("img, b")).toBeNull()
  })
})

describe("Application detail: blocked document (C-DOC-3)", () => {
  const REDDIT =
    "I work well in remote teams. I acted as the main frontend partner to product, backend and testing teams and cut implementation rework by 50%. At another company, I cut production crashes by 25%."

  it("the owner's reproduction: the flagged term is shown, and no download is offered", async () => {
    const app = readyApplication({
      state: "documents_blocked",
      blockedDocument: "cover_letter",
      blockedClaim: REDDIT,
      blockedClaimCause: "unsupported_terms",
      blockedClaimTerms: ["remote"],
      blockedClaimMoreTerms: 0,
      documents: [],
    })
    openDocuments(`/applications/${app.id}`, { applications: [app] })

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Document blocked")
    expect(alert).toHaveTextContent("Part of the cover letter claims more than the facts it cites can back up")
    expect(within(alert).getByRole("list", { name: "Flagged by Eve" })).toHaveTextContent("remote")
    expect(within(alert).getByText("The part that was blocked")).toBeVisible()
    expect(alert).toHaveTextContent(REDDIT)
    const region = await documentsRegion()
    expect(within(region).queryByRole("link", { name: /Download/ })).not.toBeInTheDocument()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it.each([
    ["unsupported_terms", "claims more than the facts it cites can back up"],
    ["number_order", "don't all come from one cited fact"],
    ["no_fact", "cited no Career Profile fact"],
    ["contact_detail", "included contact details"],
    ["names_target", "named the employer or the role"],
    ["unknown_fact", "cited a fact that wasn't among the approved facts"],
    ["not_confirmed", "couldn't confirm the meaning"],
  ] as const)("cause %s shows its own message", async (cause, line) => {
    const app = readyApplication({
      state: "documents_blocked",
      blockedDocument: "resume",
      blockedClaim: "Led a team of 12 engineers",
      blockedClaimCause: cause,
      blockedClaimTerms: ["engineers"],
      blockedClaimMoreTerms: 0,
      documents: [],
    })
    openDocuments(`/applications/${app.id}`, { applications: [app] })

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent(line)
  })

  it("a row blocked before this release shows the fallback and no list", async () => {
    const app = readyApplication({ state: "documents_blocked", blockedDocument: "cover_letter", blockedClaim: null, documents: [] })
    openDocuments(`/applications/${app.id}`, { applications: [app] })

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("The cover letter didn't pass one of Eve's checks")
    expect(alert).toHaveTextContent("This page can't say which one.")
    expect(within(alert).queryByRole("list")).not.toBeInTheDocument()
    expect(alert).not.toHaveTextContent("The part that was blocked")
  })

  it("a cause this build does not know shows the fallback too", async () => {
    const app = readyApplication({
      state: "documents_blocked",
      blockedDocument: "resume",
      blockedClaim: "Some blocked line",
      blockedClaimCause: "future_cause",
      documents: [],
    })
    openDocuments(`/applications/${app.id}`, { applications: [app] })

    expect(await screen.findByRole("alert")).toHaveTextContent("This page can't say which one.")
  })

  it.each(["contact_detail", "names_target", "unknown_fact", "not_confirmed"] as const)(
    "cause %s never shows a list, whatever terms arrive",
    async (cause) => {
      const app = readyApplication({
        state: "documents_blocked",
        blockedDocument: "resume",
        blockedClaim: "Led a team of 12 engineers",
        blockedClaimCause: cause,
        blockedClaimTerms: ["engineers"],
        blockedClaimMoreTerms: 2,
        documents: [],
      })
      openDocuments(`/applications/${app.id}`, { applications: [app] })

      const alert = await screen.findByRole("alert")
      expect(within(alert).queryByRole("list")).not.toBeInTheDocument()
      expect(alert).not.toHaveTextContent("flagged item")
    }
  )

  it("number_order labels the list as numbers and keeps every number as written", async () => {
    const app = readyApplication({
      state: "documents_blocked",
      blockedDocument: "cover_letter",
      blockedClaim: "I cut our release cycle from 2 days to 3 weeks",
      blockedClaimCause: "number_order",
      blockedClaimTerms: ["2", "3"],
      blockedClaimMoreTerms: 0,
      documents: [],
    })
    openDocuments(`/applications/${app.id}`, { applications: [app] })

    const alert = await screen.findByRole("alert")
    const list = within(alert).getByRole("list", { name: "Numbers Eve checked" })
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["2", "3"])
  })

  it("counts the terms it could not list", async () => {
    const app = readyApplication({
      state: "documents_blocked",
      blockedDocument: "resume",
      blockedClaim: "remote teams",
      blockedClaimCause: "unsupported_terms",
      blockedClaimTerms: ["remote"],
      blockedClaimMoreTerms: 4,
      documents: [],
    })
    openDocuments(`/applications/${app.id}`, { applications: [app] })

    expect(await screen.findByRole("alert")).toHaveTextContent("4 flagged items aren't shown.")
  })

  it("shows a model-written term as text, never as markup", async () => {
    const app = readyApplication({
      state: "documents_blocked",
      blockedDocument: "resume",
      blockedClaim: "<img src=x onerror=alert(1)> appeared",
      blockedClaimCause: "unsupported_terms",
      blockedClaimTerms: ['<img src=x onerror="alert(1)">'],
      blockedClaimMoreTerms: 0,
      documents: [],
    })
    openDocuments(`/applications/${app.id}`, { applications: [app] })

    const alert = await screen.findByRole("alert")
    expect(within(alert).getByRole("listitem")).toHaveTextContent('<img src=x onerror="alert(1)">')
    expect(alert.querySelector("img")).toBeNull()
  })
})

describe("Application detail: generating documents", () => {
  it("a prepared Application generates its documents, polls while Generating, then shows them with the version", async () => {
    const app = readyApplication({ state: "prepared", careerProfileVersion: null, documents: [] })
    const { user, api } = openDocuments(`/applications/${app.id}`, { applications: [app] }, { fakeTimers: true })

    expect(await screen.findByText("Draft")).toBeVisible()
    expect(screen.queryByText(/Profile version/)).not.toBeInTheDocument()
    expect(
      screen.getByText("No documents yet. Generate a resume and cover letter for this posting from your approved Career Profile.")
    ).toBeVisible()
    expect(within(await documentsRegion()).getByText("No resume for this Application yet.")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Generate documents" }))

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Writing your resume and cover letter. This usually takes under a minute."
    )
    expect(screen.getByText("Draft")).toBeVisible()
    await advance(5000)
    expect(await screen.findByText("Profile version 1")).toBeVisible()
    expect(await screen.findByRole("link", { name: "Download PDF, Resume" })).toBeVisible()
    expect(api.requests).toEqual([{ method: "POST", path: `/v1/applications/${app.id}/documents/generate`, body: null }])
  })

  it("without a name: shows the contact_details_missing message with a link to Settings > Contact details", async () => {
    const app = readyApplication({ state: "prepared", careerProfileVersion: null, documents: [] })
    const { user, currentPath } = openDocuments(`/applications/${app.id}`, { applications: [app], contact: { fullName: "", lines: [] } })

    await user.click(await screen.findByRole("button", { name: "Generate documents" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Add your name to your contact details before generating documents. Nothing was sent. Add contact details"
    )
    await user.click(screen.getByRole("link", { name: "Add contact details" }))
    expect(currentPath()).toBe("/settings#contact")
    expect(await screen.findByRole("region", { name: "Contact details" })).toBeVisible()
  })

  it("storage_error shows C-DOC-28 with its muted line and Generate again, which regenerates", async () => {
    const app = readyApplication({ state: "documents_failed", failure: "storage_error", careerProfileVersion: null, documents: [] })
    const { user, api } = openDocuments(`/applications/${app.id}`, { applications: [app] })

    expect(await screen.findByText("Couldn't save your documents on the server. Nothing was lost; try again later.")).toBeVisible()
    expect(
      screen.getByText(
        "Your Career Profile and this posting are fine. The server's storage needs fixing, so another try may fail the same way until it is."
      )
    ).toBeVisible()
    expect(screen.getByText("Draft")).toBeVisible()
    expect(screen.getAllByRole("button", { name: /Generate/ })).toHaveLength(1)
    await user.click(screen.getByRole("button", { name: "Generate again" }))

    expect(await screen.findByRole("status")).toHaveTextContent("Writing your resume and cover letter.")
    expect(api.requests).toEqual([{ method: "POST", path: `/v1/applications/${app.id}/documents/generate`, body: null }])
  })

  it("interrupted shows C-DOC-29 with Generate again", async () => {
    const app = readyApplication({ state: "documents_failed", failure: "interrupted", careerProfileVersion: null, documents: [] })
    openDocuments(`/applications/${app.id}`, { applications: [app] })

    expect(
      await screen.findByText("Documents weren't generated: the server restarted while they were being written. Nothing was lost.")
    ).toBeVisible()
    expect(screen.getByRole("button", { name: "Generate again" })).toBeVisible()
  })

  it.each([
    ["not_approved", "Documents weren't generated: Anthropic isn't approved, so nothing was sent.", { link: "Review and approve", href: "/privacy#ai-provider" }],
    ["no_career_profile", "Documents weren't generated: you don't have an approved Career Profile yet.", { link: "Go to Career Profile", href: "/profile" }],
    [
      "not_configured",
      "Documents weren't generated: the Anthropic API key is missing on the server, so nothing was sent. Add it to the server's environment, then generate again.",
      null,
    ],
    ["provider_error", "Documents weren't generated: Anthropic didn't answer. Try again in a few minutes.", "generate"],
    [
      "invalid_output",
      "Documents weren't generated: Anthropic's reply couldn't be turned into a resume and cover letter, so nothing was kept. Generate again.",
      "generate",
    ],
    ["timed_out", "Documents weren't generated: Anthropic took too long. Try again in a few minutes.", "generate"],
    [
      "render_check_failed",
      "Documents weren't generated: the PDF's text didn't match what was written, so it wasn't kept. Generate again.",
      "generate",
    ],
    [null, "Documents weren't generated. Generate again.", "generate"],
  ] as const)("failure %s shows its C-DOC line and action", async (failure, line, action) => {
    const app = readyApplication({ state: "documents_failed", failure, careerProfileVersion: null, documents: [] })
    openDocuments(`/applications/${app.id}`, { applications: [app] })

    expect(await screen.findByText(line)).toBeVisible()
    if (action === "generate") expect(screen.getByRole("button", { name: "Generate again" })).toBeVisible()
    else expect(screen.queryByRole("button", { name: /Generate/ })).not.toBeInTheDocument()
    if (action && typeof action === "object") expect(screen.getByRole("link", { name: action.link })).toHaveAttribute("href", action.href)
  })

  it("the button reads Starting… while the request is in flight (C-DOC-13)", async () => {
    const app = readyApplication({ state: "prepared", careerProfileVersion: null, documents: [] })
    let release: () => void = () => undefined
    const { user } = openDocuments(`/applications/${app.id}`, { applications: [app] })
    server.use(
      http.post("/v1/applications/:id/documents/generate", async () => {
        await new Promise<void>((resolve) => (release = resolve))
        return apiErrorResponse("internal_error")
      })
    )

    await user.click(await screen.findByRole("button", { name: "Generate documents" }))
    const busy = await screen.findByRole("button", { name: "Starting…" })
    expect(busy).toBeDisabled()
    expect(busy).toHaveAttribute("aria-busy", "true")
    release()
    expect(await screen.findByRole("button", { name: "Generate documents" })).toBeEnabled()
  })

  it("a server failure starting generation toasts C-ERR-2", async () => {
    const app = readyApplication({ state: "prepared", careerProfileVersion: null, documents: [] })
    const { user } = openDocuments(`/applications/${app.id}`, { applications: [app] })
    server.use(http.post("/v1/applications/:id/documents/generate", () => apiErrorResponse("internal_error")))

    await user.click(await screen.findByRole("button", { name: "Generate documents" }))
    expect(await findToast("Couldn't generate the documents. Nothing changed. Try again.")).toBeInTheDocument()
  })

  it("ready documents offer no Generate button", async () => {
    const app = readyApplication()
    openDocuments(`/applications/${app.id}`, { applications: [app] })

    await documentsRegion()
    expect(screen.queryByRole("button", { name: /Generate/ })).not.toBeInTheDocument()
  })
})

describe("Prepare documents from a ranked posting", () => {
  it("creates the Application and opens it", async () => {
    const posting = rankedPosting({ match: strongMatch() })
    const { user, api, currentPath } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })

    const prepare = await screen.findByRole("button", { name: "Prepare documents for Senior Frontend Engineer at Acme Payments" })
    expect(prepare).toHaveTextContent("Prepare documents")
    await user.click(prepare)

    expect(await screen.findByRole("button", { name: "Generate documents" })).toBeVisible()
    expect(currentPath()).toBe(`/applications/${api.state.applications[0].id}`)
    expect(api.requests).toEqual([{ method: "POST", path: "/v1/applications", body: { jobPostingId: posting.id } }])
  })

  // r-AA (AA-6.4, Gherkin R-4504): a ranked posting that already has an Application no longer offers
  // "Prepare documents"; the create still answers with the existing Application (ranked path, AA-1.6).
  it("a ranked posting with an existing Application offers no Prepare button, and a create returns that Application", async () => {
    const posting = rankedPosting()
    const existing = readyApplication({ jobPostingId: posting.id })
    const { api } = openDocuments(`/postings/${posting.id}`, { applications: [existing] }, { discovery: { postings: [posting] } })

    await screen.findByRole("heading", { level: 1 })
    expect(screen.queryByRole("button", { name: /^Prepare documents/ })).not.toBeInTheDocument()
    const response = await fetch(new URL("/v1/applications", window.location.origin), {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": TEST_CSRF_TOKEN },
      body: JSON.stringify({ jobPostingId: posting.id }),
    })
    expect(await response.json()).toMatchObject({ created: false, application: { id: existing.id } })
    expect(api.state.applications).toHaveLength(1)
  })

  // r-AA (AA-4.1): "anyway" now confirms in a dialog first; covered in apply-anyway-posting.test.tsx.
  it.each([
    ["skipped", { status: "skipped", rank: null, skipReason: "weak_core_match" }],
    ["excluded", { status: "excluded", rank: null, skipReason: "violated_rule", skipDetail: "industry", eligibility: { ...rankedPosting().eligibility!, rules: [{ rule: "industry" as const, result: "violated" as const, quote: null }] } }],
  ] satisfies [string, Partial<JobPostingDetail>][])("is offered as 'Prepare documents anyway' on an overridable %s posting and creates the Application after the dialog", async (_label, overrides) => {
    const posting = rankedPosting(overrides)
    const { user, api, currentPath } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })

    const prepare = await screen.findByRole("button", { name: "Prepare documents anyway for Senior Frontend Engineer at Acme Payments" })
    expect(prepare).toHaveTextContent("Prepare documents anyway")
    await user.click(prepare)
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Prepare anyway" }))

    expect(await screen.findByRole("button", { name: "Generate documents" })).toBeVisible()
    expect(currentPath()).toBe(`/applications/${api.state.applications[0].id}`)
  })

  it.each(["checking", "evaluation_failed"] as const)("is not offered on a %s posting", async (status) => {
    const posting = rankedPosting({ status, rank: null })
    openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })

    await screen.findByRole("heading", { level: 1 })
    expect(screen.queryByRole("button", { name: /^Prepare documents/ })).not.toBeInTheDocument()
  })

  it("the backend's application_not_eligible refusal shows its message", async () => {
    const posting = rankedPosting()
    const { user } = openDocuments(`/postings/${posting.id}`, {}, { discovery: { postings: [posting] } })
    // The posting moved to checking after the page loaded (v1.24.0: the fake decides from the store).
    server.use(http.post("/v1/applications", () => apiErrorResponse("application_not_eligible")))

    await user.click(await screen.findByRole("button", { name: /^Prepare documents/ }))
    expect(await findToast("This Job Posting is still being checked or couldn't be checked, so it can't become an Application yet.")).toBeInTheDocument()
  })
})
