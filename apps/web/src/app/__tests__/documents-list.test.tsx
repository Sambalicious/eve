import { screen, within } from "@testing-library/react"
import { http } from "msw"
import { describe, expect, it } from "vitest"

import { apiErrorResponse, readyApplication, server } from "@/shared/testing"
import { DOCUMENTS_PATH } from "@eve/contracts"
import { openDocuments } from "./documents-helpers"

async function table() {
  return screen.findByRole("region", { name: "Documents, scrolls horizontally" })
}

describe("Documents list (/documents)", () => {
  it("opens at /documents (not in the nav since EPIC-0011) and lists each Application with its resume and cover letter downloads", async () => {
    const first = readyApplication()
    const second = readyApplication({ company: "Globex", roleTitle: "Product Engineer", requisitionId: "G-77", jobPostingId: "10000000-0000-4000-8000-000000000002" })
    const { currentPath } = openDocuments("/documents", { applications: [first, second] })

    expect(currentPath()).toBe("/documents")
    expect(await screen.findByRole("heading", { level: 1, name: "Documents" })).toBeVisible()
    expect(document.title).toBe("Documents · Eve")
    const rows = within(await table()).getAllByRole("row").slice(1)
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByRole("link", { name: "Senior Frontend Engineer at Acme Payments" })).toHaveAttribute(
      "href",
      `/applications/${first.id}`
    )
    expect(rows[0]).toHaveTextContent("R-1042")
    expect(within(rows[0]).getByRole("link", { name: "PDF, Resume, Senior Frontend Engineer at Acme Payments" })).toHaveAttribute(
      "href",
      `/v1/applications/${first.id}/documents/resume.pdf`
    )
    expect(within(rows[0]).getByRole("link", { name: "DOCX, Cover letter, Senior Frontend Engineer at Acme Payments" })).toHaveAttribute(
      "href",
      `/v1/applications/${first.id}/documents/cover-letter.docx`
    )
    expect(rows[1]).toHaveTextContent("Product Engineer at Globex")
  })

  it("shows the short cover letter status, and nothing before submission", async () => {
    openDocuments("/documents", {
      applications: [
        readyApplication({ roleTitle: "Uploaded role", coverLetterStatus: "uploaded" }),
        readyApplication({ roleTitle: "No field role", coverLetterStatus: "no_field" }),
        readyApplication({ roleTitle: "Pending role", coverLetterStatus: "not_submitted" }),
      ],
    })

    const rows = within(await table()).getAllByRole("row").slice(1)
    expect(rows[0]).toHaveTextContent(/Uploaded$/)
    expect(rows[1]).toHaveTextContent(/Not uploaded$/)
    expect(rows[2]).not.toHaveTextContent(/uploaded/i)
  })

  it("omits Applications without documents (blocked or not generated)", async () => {
    openDocuments("/documents", {
      applications: [
        readyApplication({ roleTitle: "Ready role" }),
        readyApplication({ roleTitle: "Blocked role", state: "documents_blocked", blockedDocument: "resume", blockedClaim: "x", documents: [] }),
      ],
    })

    const region = await table()
    expect(within(region).getByRole("link", { name: "Ready role at Acme Payments" })).toBeVisible()
    expect(within(region).queryByRole("link", { name: "Blocked role at Acme Payments" })).not.toBeInTheDocument()
    expect(within(region).getAllByRole("row")).toHaveLength(2)
  })

  it("a row with no role or company is named by its requisition ID once (break-ui finding 1)", async () => {
    openDocuments("/documents", { applications: [readyApplication({ roleTitle: null, company: null, requisitionId: "R-NO-TITLE-1" })] })

    const row = within(await table()).getAllByRole("row")[1]
    expect(within(row).getByRole("link", { name: "R-NO-TITLE-1" })).toBeVisible()
    expect(within(row).getAllByText("R-NO-TITLE-1")).toHaveLength(1)
  })

  it("empty: C-DOC-4", async () => {
    openDocuments("/documents")

    expect(await screen.findByRole("heading", { name: "No Tailored Documents yet" })).toBeVisible()
    expect(
      screen.getByText("Each Application gets its own resume and cover letter, generated from your approved Career Profile.")
    ).toBeVisible()
  })

  it("a load failure shows C-ERR-1 with Try again", async () => {
    openDocuments("/documents")
    server.use(http.get(DOCUMENTS_PATH, () => apiErrorResponse("bad_request")))

    // bad_request is not retried, so the error shows at once.
    expect(await screen.findByText("Couldn't load this page.")).toBeVisible()
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible()
  })
})
