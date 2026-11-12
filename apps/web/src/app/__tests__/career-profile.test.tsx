import { RESUME_MAX_BYTES } from "@eve/contracts"
import { act, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { http } from "msw"
import { describe, expect, it } from "vitest"

import { DRAFTING_POLL_MS } from "@/entities/career-profile"
import {
  apiErrorResponse,
  approvedState,
  BRIGHTWAVE_FACT,
  brightwaveSection,
  server,
  version,
  type CareerSetupState,
} from "@/shared/testing"
import { advance, confirmDialog, findDialog, findToast, openSignedIn } from "./career-setup-helpers"

const DRAFT_NOTICE =
  "This is a draft. Nothing in it is used for documents or answers until you approve it. Check every fact: documents can only claim what's here."
const FACT_5 = "Led a team of 5 frontend engineers at Brightwave Ltd, 2021–2024"
const WRONG_FILE = "Upload a PDF or DOCX resume up to 5 MB."
const FILE_BLAMED = "Couldn't draft a Career Profile from this file."
const NO_TEXT =
  "Couldn't draft a Career Profile from this file. It has no text the assistant can read, which usually means it's a scan or an image. Upload a PDF or DOCX with selectable text."
const TOO_MANY_PAGES =
  "This PDF has more than 20 pages, the limit for a resume, so nothing was sent. Upload a shorter version without portfolios or case studies."
const TOO_MANY_CHARACTERS =
  "This resume has more than 60,000 characters of text, so nothing was sent. Cut it down to the roles and facts you want employers to see, then upload it again."
const DOCX_LIMITS =
  "This Word file is too big to open safely once unpacked, so nothing was sent. Large images or embedded files usually cause this. Remove them or save it as a PDF, then upload it again."
const PARSE_LIMITS =
  "This file took too long to read, so nothing was sent. Save it again as a PDF from your word processor, then upload it again."
const NO_VERIFIED_FACTS =
  "Couldn't draft a Career Profile from this resume. Anthropic's reply had no facts the assistant could match to your resume text. Try again, or upload a version with plainer formatting."
const PROVIDER_FAILED =
  "Couldn't reach Anthropic to draft your Career Profile, so no draft was made. Your file is fine. Try again in a few minutes."
const NOT_CONFIGURED =
  "Resume drafting isn't set up on the server yet: the Anthropic API key is missing. Nothing was sent. Add the key to the server's environment, then try again."
const STORAGE_FAILED = "Couldn't save your resume on the server. Nothing was sent to Anthropic. Try again later."
const STORAGE_DETAIL =
  "Your file is fine. The server's storage needs fixing, so another try may fail the same way until it is."
const dropped = (d: number) =>
  `The assistant left out ${d} fact(s) or heading(s) it couldn't match to your resume: the quoted text wasn't in your resume, or it didn't contain every number, date, title, employer and name they stated. If something from your resume is missing below, add it with Edit Career Profile.`

const failedAttempt = (failureReason: NonNullable<CareerSetupState["drafting"]>["failureReason"]) => ({
  status: "failed" as const,
  filename: "ada-okafor-resume.pdf",
  startedAt: "2026-10-18T09:00:00.000Z",
  failureReason,
})

const resume = (name: string, bytes = 2048) => new File([new Uint8Array(bytes)], name)

function fileInput() {
  return document.querySelector<HTMLInputElement>('input[type="file"]')!
}

describe("Career Profile (career-profile.feature)", () => {
  describe("@sad @ac-1.2 @ac-1.1 @r2 Resume upload is unavailable until Anthropic is approved", () => {
    it("shows C-PROFILE-1, offers no file input, and sends nothing", async () => {
      const { api } = openSignedIn("/profile")

      expect(await screen.findByText("Approve Anthropic before uploading your resume.")).toBeVisible()
      expect(fileInput()).toBeNull()
      expect(screen.queryByRole("button", { name: "Choose resume" })).not.toBeInTheDocument()
      expect(screen.getByRole("link", { name: "Review and approve" })).toHaveAttribute("href", "/privacy#ai-provider")
      expect(api.requests).toEqual([])
    })
  })

  describe("@happy @ac-1.1 Uploading a resume drafts a Career Profile awaiting approval", () => {
    it("uploads the PDF as multipart, shows the drafting line, then version 1 as a draft with source quotes", async () => {
      const { user, api } = openSignedIn("/profile", approvedState(), { fakeTimers: true })

      await user.upload(await waitForFileInput(), resume("ada-okafor-resume.pdf"))

      expect(await screen.findByText("Drafting your profile from ada-okafor-resume.pdf…")).toBeVisible()
      expect(api.requestsTo("POST", "/v1/career-profile/resume")).toEqual([
        { method: "POST", path: "/v1/career-profile/resume", body: { file: "ada-okafor-resume.pdf", fields: ["resume"] } },
      ])

      act(() => api.finishDrafting())
      // The next 5 s poll picks up the result.
      await advance(DRAFTING_POLL_MS)
      expect(await screen.findByText(DRAFT_NOTICE)).toBeVisible()
      const draft = screen.getByRole("region", { name: "Version 1" })
      expect(within(draft).getByText("Draft", { selector: '[data-slot="badge"]' })).toBeVisible()
      expect(within(draft).getByText(BRIGHTWAVE_FACT, { selector: "p" })).toBeVisible()
      // The resume text each fact came from is shown under it.
      expect(within(draft).getByText("cut checkout page load time by 38%")).toBeVisible()
      expect(within(draft).getByRole("button", { name: "Approve Career Profile" })).toBeVisible()
      expect(api.state.versions.map((v) => [v.version, v.status])).toEqual([[1, "draft"]])
    })

    it("accepts a DOCX resume too", async () => {
      const { user, api } = openSignedIn("/profile", approvedState())

      await user.upload(await waitForFileInput(), resume("Ada Okafor CV.docx"))

      expect(await screen.findByText("Drafting your profile from Ada Okafor CV.docx…")).toBeVisible()
      expect(api.state.drafting?.filename).toBe("Ada Okafor CV.docx")
    })
  })

  describe("@validation @ac-1.1 Uploading a file that is not a PDF or DOCX resume is refused", () => {
    it.each([
      ["ada-okafor-resume.png", 2048],
      ["too-big.pdf", RESUME_MAX_BYTES + 1],
      ["empty.pdf", 0],
    ])("refuses %s with C-VAL-PROFILE-1 and creates no Career Profile", async (name, bytes) => {
      const { api } = openSignedIn("/profile", approvedState())
      // A picker that ignores `accept` (drag and drop, "All files" in the OS dialog).
      const user = userEvent.setup({ applyAccept: false, delay: null })

      await user.upload(await waitForFileInput(), resume(name, bytes))

      expect(await screen.findByRole("alert")).toHaveTextContent(WRONG_FILE)
      expect(api.requestsTo("POST", "/v1/career-profile/resume")).toEqual([])
      expect(api.state.versions).toEqual([])
    })

    it("shows the same refusal when the backend's content check refuses the file", async () => {
      const { user, api } = openSignedIn("/profile", approvedState())
      server.use(http.post("/v1/career-profile/resume", () => apiErrorResponse("resume_file_invalid")))

      await user.upload(await waitForFileInput(), resume("renamed-image.pdf"))

      expect(await screen.findByRole("alert")).toHaveTextContent(WRONG_FILE)
      expect(api.state.versions).toEqual([])
    })
  })

  describe("drafting failures (design-spec.r3 F1, failureReason table)", () => {
    it("@sad @r4 Drafting that fails shows the failure state with \"Try again\"", async () => {
      const { user, api } = openSignedIn("/profile", approvedState(), { fakeTimers: true })
      api.failNextDraft("provider_error")

      await user.upload(await waitForFileInput(), resume("ada-okafor-resume.pdf"))
      await screen.findByText(/^Drafting your profile/)
      act(() => api.finishDrafting())
      // The next 5 s poll picks up the result.
      await advance(DRAFTING_POLL_MS)

      expect(await screen.findByText(PROVIDER_FAILED)).toBeVisible()
      expect(screen.getByRole("button", { name: "Try again" })).toBeVisible()
      expect(api.state.versions).toEqual([])
    })

    it("@sad @r4 \"Try again\" after a drafting failure drafts the Career Profile", async () => {
      const { user, api } = openSignedIn(
        "/profile",
        { ...approvedState(), drafting: failedAttempt("provider_error") },
        { fakeTimers: true }
      )

      expect(await screen.findByText(PROVIDER_FAILED)).toBeVisible()
      await user.click(screen.getByRole("button", { name: "Try again" }))
      await user.upload(fileInput(), resume("ada-okafor-resume.pdf"))
      await screen.findByText("Drafting your profile from ada-okafor-resume.pdf…")
      act(() => api.finishDrafting())
      // The next 5 s poll picks up the result.
      await advance(DRAFTING_POLL_MS)

      expect(await screen.findByText(DRAFT_NOTICE)).toBeVisible()
      expect(screen.queryByText(PROVIDER_FAILED)).not.toBeInTheDocument()
      expect(api.state.versions.map((v) => [v.version, v.status])).toEqual([[1, "draft"]])
    })

    it("@sad @r4 Drafting that keeps no verified fact shows the failure state with \"Try again\"", async () => {
      const { user, api } = openSignedIn("/profile", approvedState(), { fakeTimers: true })
      api.failNextDraft("no_verified_facts")

      await user.upload(await waitForFileInput(), resume("ada-okafor-resume.pdf"))
      await screen.findByText(/^Drafting your profile/)
      act(() => api.finishDrafting())
      // The next 5 s poll picks up the result.
      await advance(DRAFTING_POLL_MS)

      expect(await screen.findByText(NO_VERIFIED_FACTS)).toBeVisible()
      expect(screen.getByRole("button", { name: "Try again" })).toBeVisible()
      expect(api.state.versions).toEqual([])
    })

    it.each([
      ["provider_error", PROVIDER_FAILED, "Try again"],
      ["timed_out", PROVIDER_FAILED, "Try again"],
      ["invalid_output", NO_VERIFIED_FACTS, "Try again"],
      ["no_verified_facts", NO_VERIFIED_FACTS, "Try again"],
      ["not_configured", NOT_CONFIGURED, "Try again"],
      ["not_approved", "Approve Anthropic before uploading your resume.", "Choose resume"],
    ] as const)("failureReason %s shows its copy and %s", async (failureReason, message, button) => {
      openSignedIn("/profile", { ...approvedState(), drafting: failedAttempt(failureReason) })

      expect(await screen.findByRole("alert")).toHaveTextContent(message)
      expect(screen.getByRole("button", { name: button })).toBeVisible()
      // No drafting failure blames the file: C-PROFILE-4 is only for a refused upload.
      expect(screen.queryByText(FILE_BLAMED)).not.toBeInTheDocument()
    })
  })

  describe("QA-2B-03: a resume not used because edits were saved first (C-PROFILE-17)", () => {
    const notUsed = (filename: string) =>
      filename
        ? `Your resume ${filename} wasn't used, because you saved edits first. To draft from the resume instead, discard this draft and upload the resume again.`
        : "Your resume wasn't used, because you saved edits first. To draft from the resume instead, discard this draft and upload the resume again."
    const draftExists = (filename = "ada-okafor-resume.pdf") => ({ ...failedAttempt("draft_exists"), filename })

    it("shows C-PROFILE-17 on a later draft under C-PROFILE-6, and its Discard draft opens C-CONFIRM-17", async () => {
      const { user, api } = openSignedIn("/profile", {
        ...approvedState(),
        versions: [version(1, "approved"), version(2, "draft")],
        drafting: draftExists(),
      })

      const notice = await screen.findByRole("status", { name: /^Your resume ada-okafor-resume\.pdf wasn't used/ })
      expect(notice).toHaveTextContent(notUsed("ada-okafor-resume.pdf"))
      const draftNotice = screen.getByText(/^Version 2 is a draft\./)
      const firstFact = screen.getByText(BRIGHTWAVE_FACT, { selector: "p" })
      expect(draftNotice.compareDocumentPosition(notice)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      expect(notice.compareDocumentPosition(firstFact)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      // An info notice, not the failure alert, and not the drop zone.
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      expect(screen.queryByText(NO_VERIFIED_FACTS)).not.toBeInTheDocument()

      await user.click(within(notice).getByRole("button", { name: "Discard draft" }))
      const dialog = await findDialog("Discard draft version 2?")
      expect(dialog).toHaveTextContent("Your edits are deleted. Version 1 stays in use.")
      await confirmDialog(user, "Discard draft version 2?", "Discard draft")

      // Discarded: the notice goes, and the leftover draft_exists attempt shows nowhere else.
      expect(await screen.findByRole("button", { name: "Edit Career Profile" })).toBeVisible()
      expect(screen.queryByText(/wasn't used, because you saved edits first/)).not.toBeInTheDocument()
      expect(screen.queryByText(NO_VERIFIED_FACTS)).not.toBeInTheDocument()
      expect(api.state.versions.map((v) => [v.version, v.status])).toEqual([[1, "approved"]])
    })

    it("shows the no-filename C-PROFILE-17 on a first draft under C-PROFILE-3, and Discard draft opens the confirm", async () => {
      const { user, api } = openSignedIn("/profile", {
        ...approvedState(),
        versions: [version(1, "draft")],
        drafting: draftExists(""),
      })

      const notice = await screen.findByRole("status", { name: /^Your resume wasn't used/ })
      expect(notice).toHaveTextContent(notUsed(""))
      expect(screen.getByText(DRAFT_NOTICE).compareDocumentPosition(notice)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

      await user.click(within(notice).getByRole("button", { name: "Discard draft" }))
      await findDialog("Discard draft version 1?")
      await confirmDialog(user, "Discard draft version 1?", "Discard draft")

      // Back to the empty page: the drop zone is offered, with no failure from the draft_exists attempt.
      expect(await screen.findByRole("button", { name: "Choose resume" })).toBeVisible()
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      expect(api.state.versions).toEqual([])
    })

    it("goes away once the draft is approved", async () => {
      const { user } = openSignedIn("/profile", {
        ...approvedState(),
        versions: [version(1, "approved"), version(2, "draft")],
        drafting: draftExists(),
      })

      await screen.findByRole("status", { name: /wasn't used, because you saved edits first/ })
      await user.click(screen.getByRole("button", { name: "Approve version 2" }))
      await confirmDialog(user, "Approve version 2?", "Approve version 2")

      expect(await findToast("Version 2 approved. New Tailored Documents use it.")).toBeVisible()
      expect(screen.queryByText(/wasn't used, because you saved edits first/)).not.toBeInTheDocument()
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    })

    it("does not show while a new upload is drafting", async () => {
      openSignedIn("/profile", {
        ...approvedState(),
        versions: [version(1, "approved"), version(2, "draft")],
        drafting: { status: "drafting", filename: "cv-2.pdf", startedAt: new Date().toISOString(), failureReason: null },
      })

      await screen.findByText(/^Version 2 is a draft\./)
      expect(screen.queryByText(/wasn't used, because you saved edits first/)).not.toBeInTheDocument()
    })

    it.each([
      ["provider_error", PROVIDER_FAILED],
      ["no_verified_facts", NO_VERIFIED_FACTS],
      ["storage_error", STORAGE_FAILED],
    ] as const)("a %s failure with no draft still shows in the drop zone on the page", async (failureReason, message) => {
      openSignedIn("/profile", { ...approvedState(), drafting: failedAttempt(failureReason) })

      const alert = await screen.findByRole("alert")
      expect(alert).toHaveTextContent(message)
      // The alert belongs to the drop zone: it describes the file input.
      expect(document.querySelector<HTMLInputElement>('input[type="file"]')).toHaveAttribute("aria-describedby", alert.id)
      expect(screen.getByRole("button", { name: "Try again" })).toBeVisible()
      expect(screen.queryByText(/wasn't used, because you saved edits first/)).not.toBeInTheDocument()
    })
  })

  describe("uploading a new resume over an approved profile", () => {
    it("offers \"Upload a new resume\" under the approved version", async () => {
      openSignedIn("/profile", { ...approvedState(), versions: [version(1, "approved")] })
      const section = await screen.findByRole("region", { name: "Upload a new resume" })
      expect(within(section).getByText(/Your approved profile stays in use until you approve the new draft/)).toBeVisible()
      expect(within(section).getByRole("button", { name: "Choose resume" })).toBeVisible()
    })

    it("hides it while a draft is open", async () => {
      openSignedIn("/profile", { ...approvedState(), versions: [version(1, "approved"), version(2, "draft")] })
      await screen.findByRole("button", { name: "Approve version 2" })
      expect(screen.queryByRole("region", { name: "Upload a new resume" })).not.toBeInTheDocument()
    })
  })

  describe("storage failure (QA-O3, C-PROFILE-10 and C-PROFILE-10a)", () => {
    it("@sad @r4 A storage failure shows the storage error and makes no Anthropic call", async () => {
      const { user, api } = openSignedIn("/profile", approvedState())
      api.failNextUploadStorage()

      await user.upload(await waitForFileInput(), resume("ada-okafor-resume.pdf"))

      const alert = await screen.findByRole("alert")
      expect(alert).toHaveTextContent(STORAGE_FAILED)
      expect(within(alert).getByText(STORAGE_DETAIL)).toBeVisible()
      expect(screen.getByRole("button", { name: "Try again" })).toBeVisible()
      expect(screen.queryByText(FILE_BLAMED, { exact: false })).not.toBeInTheDocument()
      expect(api.state.drafting).toMatchObject({ status: "failed", failureReason: "storage_error" })
      expect(api.state.versions).toEqual([])

      // Once storage works again, the next upload drafts and the error clears.
      await user.upload(fileInput(), resume("ada-okafor-resume.pdf"))
      expect(await screen.findByText("Drafting your profile from ada-okafor-resume.pdf…")).toBeVisible()
      expect(screen.queryByText(STORAGE_FAILED)).not.toBeInTheDocument()
    })

    it("@sad @r4 After a storage failure the failed attempt still shows the storage error with \"Try again\"", async () => {
      openSignedIn("/profile", { ...approvedState(), drafting: failedAttempt("storage_error") })

      const alert = await screen.findByRole("alert")
      expect(alert).toHaveTextContent(STORAGE_FAILED)
      expect(within(alert).getByText(STORAGE_DETAIL)).toBeVisible()
      expect(screen.getByRole("button", { name: "Try again" })).toBeVisible()
      expect(screen.queryByText(FILE_BLAMED, { exact: false })).not.toBeInTheDocument()
    })
  })

  describe("@validation @r4 A resume that breaches a resume limit is refused with its reason and sent nowhere", () => {
    it.each([
      ["pages", TOO_MANY_PAGES],
      ["characters", TOO_MANY_CHARACTERS],
      ["docx_limits", DOCX_LIMITS],
      ["parse_limits", PARSE_LIMITS],
      ["no_text", NO_TEXT],
    ] as const)("reason %s shows its refusal with \"Choose another file\"", async (reason, message) => {
      const { user, api } = openSignedIn("/profile", approvedState())
      api.refuseNextUpload(reason)

      await user.upload(await waitForFileInput(), resume("ada-okafor-resume.pdf"))

      expect(await screen.findByRole("alert")).toHaveTextContent(message)
      expect(screen.getByRole("button", { name: "Choose another file" })).toBeVisible()
      expect(api.state.drafting).toBeNull()
      expect(api.state.versions).toEqual([])
    })

    it("@r4 A refused resume names its reason, not only that drafting failed", async () => {
      const { user, api } = openSignedIn("/profile", approvedState())
      api.refuseNextUpload("pages")

      await user.upload(await waitForFileInput(), resume("ada-okafor-resume.pdf"))

      expect(await screen.findByRole("alert")).toHaveTextContent(TOO_MANY_PAGES)
      expect(screen.queryByText(FILE_BLAMED, { exact: false })).not.toBeInTheDocument()
    })

    it("falls back to C-PROFILE-4's first sentence when the API sends no reason", async () => {
      const { user, api } = openSignedIn("/profile", approvedState())
      api.refuseNextUpload()

      await user.upload(await waitForFileInput(), resume("ada-okafor-resume.pdf"))

      const alert = await screen.findByRole("alert")
      expect(alert.textContent).toBe(FILE_BLAMED)
      expect(screen.getByRole("button", { name: "Choose another file" })).toBeVisible()
    })
  })

  describe("source quotes and dropped items (F1 step 3c, CR2-02)", () => {
    const SECTION_QUOTE = "Brightwave Ltd, Senior Frontend Engineer, 2021-2024"
    const FACT_QUOTE = "Led a team of 4 frontend engineers at Brightwave Ltd, 2021-2024"
    const quotedSection = () => ({
      ...brightwaveSection(),
      sourceQuote: SECTION_QUOTE,
      facts: [{ id: "fact-team", text: BRIGHTWAVE_FACT, sourceQuote: FACT_QUOTE }],
    })

    it("@happy @r4 Each section and each fact shows its source quote on review", async () => {
      openSignedIn("/profile", { ...approvedState(), versions: [version(1, "draft", [quotedSection()])] })

      const section = await screen.findByRole("region", { name: "Senior Frontend Engineer" })
      const quotes = within(section).getAllByRole("figure")
      expect(quotes).toHaveLength(2)
      // The figure's name is the visible label, and the quote follows it.
      expect(quotes[0]).toHaveAccessibleName("From your resume")
      expect(quotes[0]).toHaveTextContent(`From your resume${SECTION_QUOTE}`)
      expect(quotes[1]).toHaveAccessibleName("From your resume")
      expect(quotes[1]).toHaveTextContent(`From your resume${FACT_QUOTE}`)
      // The heading's quote sits with the heading, before the facts.
      expect(within(section).getByRole("heading", { name: "Senior Frontend Engineer" }).compareDocumentPosition(quotes[0]))
        .toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      expect(within(section).queryByText("Written by you")).not.toBeInTheDocument()
      // No sr-only duplicate of the label is read out.
      expect(within(section).queryByText(/From your resume:/)).not.toBeInTheDocument()
      // No "Check this" badges: unsupported facts are dropped, never flagged.
      expect(screen.queryByText(/Check this/i)).not.toBeInTheDocument()
    })

    it("@happy @r4 A fact the Candidate writes or edits shows \"Written by you\" where the quote would be", async () => {
      const { user } = openSignedIn("/profile", { ...approvedState(), versions: [version(1, "approved", [quotedSection()])] })

      await user.click(await screen.findByRole("button", { name: "Edit Career Profile" }))
      const field = screen.getByRole("textbox", { name: "Senior Frontend Engineer at Brightwave Ltd, fact 1" })
      await user.clear(field)
      await user.type(field, FACT_5)
      await user.click(screen.getByRole("button", { name: "Save draft" }))

      await screen.findByText(/^Version 2 is a draft\./)
      const fact = screen.getByText(FACT_5, { selector: "p" }).closest("li") as HTMLElement
      expect(within(fact).getByText("Written by you")).toBeVisible()
      expect(within(fact).queryByRole("figure")).not.toBeInTheDocument()
      // The section heading kept its quote.
      expect(screen.getByRole("region", { name: "Senior Frontend Engineer" })).toHaveTextContent(SECTION_QUOTE)
    })

    it("shows \"Written by you\" for a heading with no quote", async () => {
      openSignedIn("/profile", {
        ...approvedState(),
        versions: [version(1, "draft", [{ ...quotedSection(), sourceQuote: null }])],
      })

      const section = await screen.findByRole("region", { name: "Senior Frontend Engineer" })
      expect(within(section).getAllByText("Written by you")).toHaveLength(1)
      expect(within(section).getAllByRole("figure")).toHaveLength(1)
    })

    it("@sad @r4 A drafted fact whose quote is not in the resume is dropped and counted", async () => {
      const { user, api } = openSignedIn("/profile", approvedState(), { fakeTimers: true })
      api.draftNextWith([quotedSection()], 1)

      await user.upload(await waitForFileInput(), resume("ada-okafor-resume.pdf"))
      await screen.findByText(/^Drafting your profile/)
      act(() => api.finishDrafting())
      // The next 5 s poll picks up the result.
      await advance(DRAFTING_POLL_MS)

      const notice = await screen.findByText(DRAFT_NOTICE)
      const line = screen.getByText(dropped(1))
      expect(line).toBeVisible()
      // Under the draft notice, in reading order, and not announced as an alert.
      expect(notice.compareDocumentPosition(line)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      expect(line.closest('[role="alert"],[role="status"]')).toBeNull()
      for (const quote of screen.getAllByRole("figure")) expect(quote).toHaveAccessibleName("From your resume")
    })

    it("@sad @r4 A drafted section whose own quote is not in the resume is dropped with all its facts", async () => {
      openSignedIn("/profile", {
        ...approvedState(),
        versions: [{ ...version(1, "draft", [quotedSection()]), droppedFactCount: 2 }],
      })

      expect(await screen.findByText(dropped(2))).toBeVisible()
    })

    it("@happy @r4 A version with 0 dropped facts shows no dropped line", async () => {
      openSignedIn("/profile", { ...approvedState(), versions: [version(1, "draft", [quotedSection()])] })

      await screen.findByText(DRAFT_NOTICE)
      expect(screen.queryByText(/^The assistant left out/)).not.toBeInTheDocument()
    })

    it("shows the dropped line under a later draft's notice too", async () => {
      openSignedIn("/profile", {
        ...approvedState(),
        versions: [version(1, "approved"), { ...version(2, "draft"), droppedFactCount: 3 }],
      })

      expect(await screen.findByText(dropped(3))).toBeVisible()
    })

    it("shows the dropped line in the read-only view of that version, and not for one with 0", async () => {
      const { user } = openSignedIn("/profile?version=1", {
        ...approvedState(),
        versions: [{ ...version(1, "replaced"), droppedFactCount: 4 }, version(2, "approved")],
      })

      const view = await screen.findByRole("region", { name: "Version 1" })
      expect(await within(view).findByText(dropped(4))).toBeVisible()

      await user.click(within(view).getByRole("link", { name: "Back to Career Profile" }))
      await user.click(await screen.findByRole("link", { name: "Version 2" }))
      const view2 = await screen.findByRole("region", { name: "Version 2" })
      await within(view2).findByText(BRIGHTWAVE_FACT, { selector: "p" })
      expect(within(view2).queryByText(/^The assistant left out/)).not.toBeInTheDocument()
    })
  })

  describe("upload refused by a state rule", () => {
    it("503 ai_provider_not_configured shows C-PROFILE-12", async () => {
      const { user } = openSignedIn("/profile", approvedState())
      server.use(http.post("/v1/career-profile/resume", () => apiErrorResponse("ai_provider_not_configured")))

      await user.upload(await waitForFileInput(), resume("ada-okafor-resume.pdf"))

      expect(await screen.findByRole("alert")).toHaveTextContent(NOT_CONFIGURED)
    })

    it("409 resume_drafting_in_progress shows C-PROFILE-14 with the filename once the page catches up", async () => {
      const { user, api } = openSignedIn("/profile", approvedState())
      server.use(
        http.post("/v1/career-profile/resume", () => {
          // Another tab started drafting a moment ago.
          api.state.drafting = { status: "drafting", filename: "cv-2026.pdf", startedAt: new Date().toISOString(), failureReason: null }
          return apiErrorResponse("resume_drafting_in_progress")
        })
      )

      await user.upload(await waitForFileInput(), resume("ada-okafor-resume.pdf"))

      expect(await screen.findByText("Drafting your profile from cv-2026.pdf…")).toBeVisible()
    })

    it("409 career_profile_draft_exists shows C-PROFILE-15 with \"Go to the draft\"", async () => {
      const { user, api } = openSignedIn("/profile", approvedState())
      server.use(
        http.post("/v1/career-profile/resume", () => {
          api.state.versions.push(version(1, "draft"))
          return apiErrorResponse("career_profile_draft_exists")
        })
      )

      await user.upload(await waitForFileInput(), resume("ada-okafor-resume.pdf"))

      // The refetch brings the draft in, so the page shows it and the drop zone goes away.
      expect(await screen.findByText(DRAFT_NOTICE)).toBeVisible()
    })
  })

  it("shows C-ERR-4 when drafting runs past the polling limit", async () => {
    openSignedIn("/profile", {
      ...approvedState(),
      drafting: { status: "drafting", filename: "cv.pdf", startedAt: "2026-01-01T00:00:00.000Z", failureReason: null },
    })

    expect(
      await screen.findByText("This is taking longer than usual. Refresh later to see the result.")
    ).toBeVisible()
  })

  describe("@happy @ac-1.1 An approved Career Profile becomes the source for Tailored Documents", () => {
    it("approves version 1 after C-CONFIRM-1 and shows Approved", async () => {
      const { user, api } = openSignedIn("/profile", { ...approvedState(), versions: [version(1, "draft")] })

      await user.click(await screen.findByRole("button", { name: "Approve Career Profile" }))
      const dialog = await findDialog("Approve your Career Profile?")
      expect(dialog).toHaveTextContent("Every Tailored Document will be built from these facts only.")
      await confirmDialog(user, "Approve your Career Profile?", "Approve")

      expect(await screen.findByText("Approved on 18 Oct 2026. Tailored Documents use only these facts.")).toBeVisible()
      expect(screen.getAllByText("Approved", { selector: '[data-slot="badge"]' }).length).toBeGreaterThan(0)
      expect(await findToast("Version 1 approved. New Tailored Documents use it.")).toBeVisible()
      expect(api.requestsTo("POST", "/v1/career-profile/draft/approve")[0].body).toEqual({ version: 1 })
      expect(api.state.versions[0].status).toBe("approved")
    })
  })

  describe("@happy @ac-1.1 @r2 Editing an approved Career Profile creates a new draft version", () => {
    it("saves the edit as draft version 2 and shows C-PROFILE-6 and C-PROFILE-7", async () => {
      const { user, api } = openSignedIn("/profile", { ...approvedState(), versions: [version(1, "approved")] })

      await user.click(await screen.findByRole("button", { name: "Edit Career Profile" }))
      const field = screen.getByRole("textbox", { name: "Senior Frontend Engineer at Brightwave Ltd, fact 1" })
      await user.clear(field)
      await user.type(field, FACT_5)
      await user.click(screen.getByRole("button", { name: "Save draft" }))

      expect(
        await screen.findByText(
          "Version 2 is a draft. Version 1 stays in use until you approve this one. Applications already sent keep the version they used."
        )
      ).toBeVisible()
      expect(screen.getByText("In use: version 1, approved 11 Oct 2026.")).toBeVisible()
      expect(screen.getByText(FACT_5, { selector: "p" })).toBeVisible()
      expect(await findToast("Draft version 2 saved. Approve it to use it.")).toBeVisible()
      expect(api.requestsTo("PUT", "/v1/career-profile/draft")[0].body).toEqual({
        sections: [
          {
            id: "sec-brightwave",
            kind: "experience",
            title: "Senior Frontend Engineer",
            organization: "Brightwave Ltd",
            period: "2021–2024",
            facts: [
              { id: "fact-team", text: FACT_5 },
              { id: "fact-checkout", text: "Cut checkout page load time by 38%" },
            ],
          },
        ],
      })
      expect(api.state.versions.map((v) => [v.version, v.status])).toEqual([
        [1, "approved"],
        [2, "draft"],
      ])
      // Edited facts lose their resume quote; the version in use keeps its own.
      expect(api.state.versions[1].sections[0].facts[0].sourceQuote).toBeNull()
      expect(api.state.versions[0].sections[0].facts[0].text).toBe(BRIGHTWAVE_FACT)
    })

    it("works without Anthropic approval, since editing sends nothing to a provider", async () => {
      const { user } = openSignedIn("/profile", { versions: [version(1, "approved")] })

      await user.click(await screen.findByRole("button", { name: "Edit Career Profile" }))
      await user.click(screen.getByRole("button", { name: "Save draft" }))

      expect(await screen.findByText(/^Version 2 is a draft\./)).toBeVisible()
    })

    it("adds and removes facts", async () => {
      const { user, api } = openSignedIn("/profile", { ...approvedState(), versions: [version(1, "approved")] })

      await user.click(await screen.findByRole("button", { name: "Edit Career Profile" }))
      await user.click(screen.getByRole("button", { name: "Remove fact 2 from Senior Frontend Engineer" }))
      await user.click(screen.getByRole("button", { name: "Add fact" }))
      await user.type(
        screen.getByRole("textbox", { name: "Senior Frontend Engineer at Brightwave Ltd, fact 2" }),
        "Mentored 3 junior engineers"
      )
      await user.click(screen.getByRole("button", { name: "Save draft" }))

      await screen.findByText(/^Version 2 is a draft\./)
      const sent = api.requestsTo("PUT", "/v1/career-profile/draft")[0].body as { sections: { facts: unknown[] }[] }
      expect(sent.sections[0].facts).toEqual([
        { id: "fact-team", text: BRIGHTWAVE_FACT },
        { text: "Mentored 3 junior engineers" },
      ])
    })

    it("a save refused while drafting runs shows C-PROFILE-14 as a toast and keeps the edits", async () => {
      const { user, api } = openSignedIn("/profile", { ...approvedState(), versions: [version(1, "approved")] })
      server.use(http.put("/v1/career-profile/draft", () => apiErrorResponse("resume_drafting_in_progress")))

      await user.click(await screen.findByRole("button", { name: "Edit Career Profile" }))
      const field = screen.getByRole("textbox", { name: "Senior Frontend Engineer at Brightwave Ltd, fact 1" })
      await user.clear(field)
      await user.type(field, FACT_5)
      await user.click(screen.getByRole("button", { name: "Save draft" }))

      expect(
        await findToast("Your Career Profile is still being drafted. Wait for it to finish, then try again.")
      ).toBeVisible()
      expect(screen.getByRole("textbox", { name: "Senior Frontend Engineer at Brightwave Ltd, fact 1" })).toHaveValue(FACT_5)
      expect(api.state.versions).toHaveLength(1)
    })

    it("Cancel leaves edit mode without saving", async () => {
      const { user, api } = openSignedIn("/profile", { ...approvedState(), versions: [version(1, "approved")] })

      await user.click(await screen.findByRole("button", { name: "Edit Career Profile" }))
      await user.click(screen.getByRole("button", { name: "Cancel" }))

      expect(screen.getByRole("button", { name: "Edit Career Profile" })).toBeVisible()
      expect(api.requests).toEqual([])
    })
  })

  describe("@duplicate @ac-1.1 @r2 Only one draft version exists at a time", () => {
    it("Continue editing draft saves into version 2; no version 3 appears", async () => {
      const draft2 = version(2, "draft", [
        { ...brightwaveSection(), facts: [{ id: "fact-team", text: FACT_5, sourceQuote: null }] },
      ])
      const { user, api } = openSignedIn("/profile", { ...approvedState(), versions: [version(1, "approved"), draft2] })

      expect(await screen.findByRole("button", { name: "Continue editing draft" })).toBeVisible()
      expect(screen.queryByRole("button", { name: "Edit Career Profile" })).not.toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Continue editing draft" }))
      await user.click(screen.getByRole("button", { name: "Add fact" }))
      await user.type(
        screen.getByRole("textbox", { name: "Senior Frontend Engineer at Brightwave Ltd, fact 2" }),
        "Introduced visual regression tests"
      )
      await user.click(screen.getByRole("button", { name: "Save draft" }))

      expect(await screen.findByText("Introduced visual regression tests", { selector: "p" })).toBeVisible()
      expect(screen.getByText(FACT_5, { selector: "p" })).toBeVisible()
      expect(api.state.versions.map((v) => v.version)).toEqual([1, 2])
    })
  })

  describe("@happy @ac-1.1 @r2 Approving a later version makes it the source for new Tailored Documents", () => {
    it("approves version 2 after C-CONFIRM-16; version 1 becomes Replaced", async () => {
      const { user, api } = openSignedIn("/profile", {
        ...approvedState(),
        versions: [version(1, "approved"), version(2, "draft")],
      })

      await user.click(await screen.findByRole("button", { name: "Approve version 2" }))
      const dialog = await findDialog("Approve version 2?")
      expect(dialog).toHaveTextContent(
        "New Tailored Documents will use version 2 only. Applications already sent keep the version they used."
      )
      await confirmDialog(user, "Approve version 2?", "Approve version 2")

      expect(await findToast("Version 2 approved. New Tailored Documents use it.")).toBeVisible()
      const history = screen.getByRole("region", { name: "Version history" })
      const rows = within(history).getAllByRole("listitem")
      expect(rows[0]).toHaveTextContent(/Version 2\s*Approved/)
      expect(rows[1]).toHaveTextContent(/Version 1\s*Replaced/)
      expect(api.state.versions.map((v) => v.status)).toEqual(["replaced", "approved"])
    })
  })

  describe("@happy @ac-1.1 @r2 Discarding a draft version leaves the approved version in use", () => {
    it("discards version 2 after C-CONFIRM-17", async () => {
      const { user, api } = openSignedIn("/profile", {
        ...approvedState(),
        versions: [version(1, "approved"), version(2, "draft")],
      })

      await user.click(await screen.findByRole("button", { name: "Discard draft" }))
      const dialog = await findDialog("Discard draft version 2?")
      expect(dialog).toHaveTextContent("Your edits are deleted. Version 1 stays in use.")
      await confirmDialog(user, "Discard draft version 2?", "Discard draft")

      expect(await screen.findByRole("button", { name: "Edit Career Profile" })).toBeVisible()
      expect(screen.getByText("Approved on 11 Oct 2026. Tailored Documents use only these facts.")).toBeVisible()
      expect(api.requestsTo("DELETE", "/v1/career-profile/draft")).toHaveLength(1)
      expect(api.state.versions.map((v) => [v.version, v.status])).toEqual([[1, "approved"]])
    })
  })

  describe("@validation @ac-1.1 @r2 Approving a draft version with an empty fact is refused", () => {
    const emptyFactDraft = () =>
      version(2, "draft", [
        { ...brightwaveSection(), facts: [{ id: "fact-empty", text: "", sourceQuote: null }, ...brightwaveSection().facts] },
      ])

    it("shows C-VAL-PROFILE-2 on the empty fact, sends nothing, and keeps the draft", async () => {
      const { user, api } = openSignedIn("/profile", {
        ...approvedState(),
        versions: [version(1, "approved"), emptyFactDraft()],
      })

      await user.click(await screen.findByRole("button", { name: "Approve version 2" }))

      expect(await screen.findByRole("alert")).toHaveTextContent("Enter the fact or remove it.")
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
      expect(api.requestsTo("POST", "/v1/career-profile/draft/approve")).toEqual([])
      expect(api.state.versions.map((v) => v.status)).toEqual(["approved", "draft"])
    })

    it("shows the same message when the backend refuses the approval", async () => {
      const { user, api } = openSignedIn("/profile", {
        ...approvedState(),
        versions: [version(1, "approved"), version(2, "draft")],
      })
      server.use(http.post("/v1/career-profile/draft/approve", () => apiErrorResponse("career_profile_fact_empty")))

      await user.click(await screen.findByRole("button", { name: "Approve version 2" }))
      await confirmDialog(user, "Approve version 2?", "Approve version 2")

      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
      expect(screen.getAllByText("Draft", { selector: '[data-slot="badge"]' }).length).toBeGreaterThan(0)
      expect(api.state.versions.map((v) => v.status)).toEqual(["approved", "draft"])
    })
  })

  describe("@permission An unauthenticated request cannot approve or edit a Career Profile", () => {
    it("a 401 on approve goes to sign-in and the draft stays a draft", async () => {
      const { user, api, currentPath } = openSignedIn("/profile", { ...approvedState(), versions: [version(1, "draft")] })
      server.use(http.post("/v1/career-profile/draft/approve", () => apiErrorResponse("unauthenticated")))

      await user.click(await screen.findByRole("button", { name: "Approve Career Profile" }))
      server.use(http.get("/v1/session", () => apiErrorResponse("unauthenticated")))
      await confirmDialog(user, "Approve your Career Profile?", "Approve")

      await waitFor(() => expect(currentPath()).toBe("/sign-in?next=%2Fprofile"))
      expect(api.state.versions[0].status).toBe("draft")
    })

    it("a 401 on save goes to sign-in and no version 2 exists", async () => {
      const { user, api, currentPath } = openSignedIn("/profile", { ...approvedState(), versions: [version(1, "approved")] })
      server.use(http.put("/v1/career-profile/draft", () => apiErrorResponse("session_expired")))

      await user.click(await screen.findByRole("button", { name: "Edit Career Profile" }))
      server.use(http.get("/v1/session", () => apiErrorResponse("session_expired")))
      await user.click(screen.getByRole("button", { name: "Save draft" }))

      await waitFor(() => expect(currentPath()).toBe("/sign-in?next=%2Fprofile&reason=expired"))
      expect(api.state.versions).toHaveLength(1)
    })
  })

  describe("Version history", () => {
    it("lists every version newest first and opens one read-only", async () => {
      const { user } = openSignedIn("/profile", {
        ...approvedState(),
        versions: [{ ...version(1, "replaced") }, version(2, "approved"), version(3, "draft")],
      })

      const history = await screen.findByRole("region", { name: "Version history" })
      const rows = within(history).getAllByRole("listitem")
      expect(rows.map((row) => row.textContent)).toEqual([
        expect.stringMatching(/^Version 3\s*Draft\s*Created 13 Oct 2026$/),
        expect.stringMatching(/^Version 2\s*Approved\s*Created 12 Oct 2026 · Approved 12 Oct 2026$/),
        expect.stringMatching(/^Version 1\s*Replaced\s*Created 11 Oct 2026 · Approved 11 Oct 2026$/),
      ])

      await user.click(within(history).getByRole("link", { name: "Version 1" }))

      const view = await screen.findByRole("region", { name: "Version 1" })
      expect(within(view).getByText(BRIGHTWAVE_FACT, { selector: "p" })).toBeVisible()
      expect(within(view).queryByRole("button", { name: /Approve|Edit|Discard/ })).not.toBeInTheDocument()
    })

    it("shows C-PROFILE-16 for a version that doesn't exist, with a way back", async () => {
      const { user, currentPath } = openSignedIn("/profile?version=9", { ...approvedState(), versions: [version(1, "approved")] })

      expect(await screen.findByRole("heading", { name: "Version not found" })).toBeVisible()
      expect(screen.getByText("Career Profile version 9 doesn't exist.")).toBeVisible()
      await user.click(screen.getByRole("link", { name: "Back to Career Profile" }))
      expect(currentPath()).toBe("/profile")
    })
  })

  it("shows C-ERR-1 with Try again when the profile fails to load", async () => {
    const { user } = openSignedIn("/profile", approvedState(), { fakeTimers: true })
    let isDown = true
    let attempts = 0
    server.use(
      http.get("/v1/career-profile", () => {
        attempts += 1
        return isDown ? apiErrorResponse("service_unavailable") : undefined
      })
    )

    // 5xx is retried twice, after React Query's 1 s and 2 s backoff, before the page shows the error.
    await waitFor(() => expect(attempts).toBe(1))
    await advance(1000)
    await waitFor(() => expect(attempts).toBe(2))
    await advance(2000)
    const retry = await screen.findByRole("button", { name: "Try again" })
    expect(screen.getByText("Couldn't load this page.")).toBeVisible()
    expect(attempts).toBe(3)
    isDown = false
    await user.click(retry)

    expect(await screen.findByRole("button", { name: "Choose resume" })).toBeVisible()
  })

  it("marks the Career Profile nav item Draft until a version is approved", async () => {
    openSignedIn("/profile", { ...approvedState(), versions: [version(1, "draft")] })

    expect(await screen.findByRole("link", { name: "Profile, Draft" })).toBeVisible()
  })
})

async function waitForFileInput(): Promise<HTMLInputElement> {
  await screen.findByRole("button", { name: "Choose resume" })
  return fileInput()
}
