import { cleanup, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { ApplicationDetail } from "@eve/contracts"
import { readyApplication } from "@/shared/testing"
import { openDocuments } from "./documents-helpers"

/**
 * EPIC-0009 QA gate (independent of the implementation session): the C-DOC-3 alert against
 * gherkin/blocked-claim-detail.r1.feature scenarios the implementation tests do not pin.
 */
const REDDIT =
  "I work well in remote teams. I acted as the main frontend partner to product, backend and testing teams and cut implementation rework by 50%. At another company, I cut production crashes by 25%."
const ZORVEX = "I built a React and TypeScript merchant dashboard at Brightwave Ltd on the Zorvex platform."

function blocked(overrides: Partial<ApplicationDetail> & Record<string, unknown> = {}): ApplicationDetail {
  return readyApplication({ company: "Reddit", roleTitle: "Frontend Engineer, Ads", state: "documents_blocked", blockedDocument: "cover_letter", blockedClaim: ZORVEX, documents: [], ...overrides } as Partial<ApplicationDetail>)
}

async function openAlert(app: ApplicationDetail) {
  const opened = openDocuments(`/applications/${app.id}`, { applications: [app] })
  const alert = await screen.findByRole("alert")
  return { ...opened, alert }
}

const FALLBACK_COVER = "The cover letter didn't pass one of Eve's checks, so the Application didn't go ahead. This page can't say which one."

describe("QA EPIC-0009: term list semantics (@ac-1.7, @ac-1.3)", () => {
  it("@ac-1.7: a list named by the label, 3 items in order, between the reason and the quoted paragraph", async () => {
    const { alert } = await openAlert(blocked({ blockedClaimCause: "unsupported_terms", blockedClaimTerms: ["GraphQL", "caching", "Zorvex"], blockedClaimMoreTerms: 0 }))
    const list = within(alert).getByRole("list", { name: "Flagged by Eve" })
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["GraphQL", "caching", "Zorvex"])
    const reason = within(alert).getByText(/claims more than the facts it cites can back up/)
    const quote = alert.querySelector("blockquote")!
    expect(reason.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(list.compareDocumentPosition(quote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(quote).toHaveTextContent(ZORVEX)
  })
})

describe("QA EPIC-0009: overflow (@ac-1.6, OD-4)", () => {
  it("@ac-1.6 r3: 20 listed and the one-item overflow line", async () => {
    const terms = Array.from({ length: 20 }, (_, i) => `Zeta${String.fromCharCode(97 + i)}word`)
    const { alert } = await openAlert(blocked({ blockedDocument: "resume", blockedClaimCause: "unsupported_terms", blockedClaimTerms: terms, blockedClaimMoreTerms: 1 }))
    expect(within(alert).getAllByRole("listitem")).toHaveLength(20)
    expect(alert).toHaveTextContent("1 flagged item isn't shown.")
  })

  it("@ac-1.6 121-unit row: no list, but the overflow line directly under the reason", async () => {
    const { alert } = await openAlert(blocked({ blockedDocument: "resume", blockedClaimCause: "unsupported_terms", blockedClaimTerms: [], blockedClaimMoreTerms: 1 }))
    expect(within(alert).queryByRole("list")).not.toBeInTheDocument()
    expect(within(alert).queryByText("Flagged by Eve")).not.toBeInTheDocument()
    const reason = within(alert).getByText(/Part of the resume claims more than/)
    const overflow = within(alert).getByText("1 flagged item isn't shown.")
    expect(reason.nextElementSibling).toBe(overflow)
  })

  it("@ac-1.4: an empty list with count 0 shows no label, no list and no overflow line", async () => {
    const { alert } = await openAlert(blocked({ blockedDocument: "resume", blockedClaimCause: "unsupported_terms", blockedClaimTerms: [], blockedClaimMoreTerms: 0 }))
    expect(within(alert).queryByRole("list")).not.toBeInTheDocument()
    expect(alert).not.toHaveTextContent("Flagged by Eve")
    expect(alert).not.toHaveTextContent("flagged item")
  })
})

describe("QA EPIC-0009: fallback (@ac-1.11, @ac-6.1, @ac-6.2, @ac-6.4, @ac-10.10)", () => {
  it.each([
    ["absent", {}],
    ["set to null", { blockedClaimCause: null, blockedClaimTerms: null, blockedClaimMoreTerms: null }],
  ])("@ac-6.4 %s: the fallback with the paragraph and no list", async (_shape, fields) => {
    const { alert } = await openAlert(blocked({ blockedClaim: REDDIT, ...fields }))
    expect(alert).toHaveTextContent(FALLBACK_COVER)
    expect(within(alert).queryByRole("list")).not.toBeInTheDocument()
    expect(alert.querySelector("blockquote")).toHaveTextContent(REDDIT)
  })

  it("@ac-1.11 absent cause with terms and count 3: fallback, no list, no overflow", async () => {
    const { alert } = await openAlert(blocked({ blockedClaimTerms: ["led", "Zorvex"], blockedClaimMoreTerms: 3 }))
    expect(alert).toHaveTextContent(FALLBACK_COVER)
    expect(within(alert).queryByRole("list")).not.toBeInTheDocument()
    expect(alert).not.toHaveTextContent("flagged item")
  })

  it("@ac-1.11 / @ac-10.10: an unknown cause with terms and a count shows the fallback, no list, no overflow", async () => {
    const { alert } = await openAlert(blocked({ blockedClaimCause: "some_future_kind", blockedClaimTerms: ["Zorvex"], blockedClaimMoreTerms: 2 }))
    expect(alert).toHaveTextContent(FALLBACK_COVER)
    expect(within(alert).queryByRole("list")).not.toBeInTheDocument()
    expect(alert).not.toHaveTextContent("flagged item")
    expect(within(alert).queryByText("Zorvex")).not.toBeInTheDocument()
  })

  it("@ac-10.10: the Applications list accepts a future cause and lists both Applications", async () => {
    const reddit = blocked({ blockedClaimCause: "some_future_kind", blockedClaimTerms: ["Zorvex"], blockedClaimMoreTerms: 2 })
    const verdant = readyApplication({ company: "Verdant Energy", roleTitle: "Sustainability Consultant" })
    openDocuments("/applications?view=list", { applications: [reddit, verdant] })
    expect((await screen.findAllByText(/Frontend Engineer, Ads/)).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Sustainability Consultant/).length).toBeGreaterThan(0)
  })

  it("@ac-6.2: no stored paragraph shows the fallback alone, with no claim label or quote", async () => {
    const { alert } = await openAlert(blocked({ blockedDocument: "resume", blockedClaim: null }))
    expect(alert).toHaveTextContent("The resume didn't pass one of Eve's checks")
    expect(alert).not.toHaveTextContent("The part that was blocked")
    expect(alert.querySelector("blockquote")).toBeNull()
  })
})

describe("QA EPIC-0009: copy slots (@ac-8.7, @ac-1.10, @ac-9.4, @ac-9.6, @ac-4.2)", () => {
  it.each([
    ["unsupported_terms", "cover_letter", ["remote"], "Part of the cover letter claims more than the facts it cites can back up, so the Application didn't go ahead.", "Flagged by Eve"],
    ["number_order", "resume", ["2", "3"], "Part of the resume has numbers that don't all come from one cited fact, in that fact's order, so the Application didn't go ahead.", "Numbers Eve checked"],
    ["no_fact", "resume", ["10", "Kubernetes"], "Part of the resume cited no Career Profile fact, so nothing backs up what it says. The Application didn't go ahead.", "Flagged by Eve"],
    ["contact_detail", "cover_letter", null, "Part of the cover letter included contact details, and Eve adds those only in its header. The Application didn't go ahead.", null],
    ["names_target", "cover_letter", null, "Part of the cover letter named the employer or the role, and Eve writes those names itself. The Application didn't go ahead.", null],
    ["unknown_fact", "resume", null, "Part of the resume cited a fact that wasn't among the approved facts Eve wrote from. The Application didn't go ahead.", null],
    ["not_confirmed", "cover_letter", null, "Eve couldn't confirm the meaning of this part of the cover letter, so the Application didn't go ahead. A new run can give a different result.", null],
  ] as const)("@ac-8.7 %s on the %s: its reason, its label, the title and the claim label", async (cause, document, terms, reason, label) => {
    const { alert } = await openAlert(blocked({ blockedDocument: document, blockedClaimCause: cause, blockedClaimTerms: terms === null ? null : [...terms], blockedClaimMoreTerms: terms === null ? null : 0 }))
    expect(alert).toHaveTextContent("Document blocked")
    expect(within(alert).getByText(reason)).toBeVisible()
    expect(within(alert).getByText("The part that was blocked")).toBeVisible()
    if (label === null) expect(within(alert).queryByRole("list")).not.toBeInTheDocument()
    else expect(within(alert).getByRole("list", { name: label })).toBeVisible()
  })

  it("@ac-1.10: no rendered term-list label says no fact supports, missing, not in your Career Profile, not stated or unsupported", async () => {
    const labels: string[] = []
    for (const [cause, terms] of [["unsupported_terms", ["a"]], ["no_fact", ["a", "b"]], ["number_order", ["2"]], ["number_order", ["2", "3"]]] as const) {
      const { alert } = await openAlert(blocked({ blockedClaimCause: cause, blockedClaimTerms: [...terms], blockedClaimMoreTerms: 0 }))
      labels.push(within(alert).getByRole("list").getAttribute("aria-labelledby") ? (document.getElementById(within(alert).getByRole("list").getAttribute("aria-labelledby")!)?.textContent ?? "") : "")
      cleanup()
    }
    expect(labels).toEqual(["Flagged by Eve", "Flagged by Eve", "Number Eve checked", "Numbers Eve checked"])
    for (const label of labels) for (const word of ["no fact supports", "missing", "not in your career profile", "not stated", "unsupported"]) expect(label.toLowerCase()).not.toContain(word)
  })

  it("@ac-9.4: the rendered not-confirmed message uses none of the forbidden words, for either document", async () => {
    for (const blockedDocument of ["resume", "cover_letter"] as const) {
      const { alert } = await openAlert(blocked({ blockedDocument, blockedClaimCause: "not_confirmed", blockedClaim: null }))
      const text = (alert.textContent ?? "").replace("Document blocked", "").toLowerCase()
      cleanup()
      for (const word of ["missing", "unsupported", "not stated", "career profile", "rejected", "refused", "false", "passed"]) expect(text).not.toContain(word)
      expect(text).not.toMatch(/\badd\b/)
    }
  })

  it("@ac-9.6: a not-confirmed alert holds no link, button or other control", async () => {
    const { alert } = await openAlert(blocked({ blockedClaimCause: "not_confirmed", blockedClaim: "I mentored 6 junior developers through the year." }))
    expect(within(alert).queryAllByRole("link")).toHaveLength(0)
    expect(within(alert).queryAllByRole("button")).toHaveLength(0)
    expect(screen.getByRole("button", { name: "Generate again" })).toBeVisible()
  })

  it("@ac-4.2: the names_target message is identical whichever name matched, and names neither", async () => {
    const employer = blocked({ blockedClaimCause: "names_target", blockedClaim: "I built a React and TypeScript merchant dashboard and want to bring that to Reddit." })
    const role = blocked({ blockedClaimCause: "names_target", blockedClaim: "As a Frontend Engineer, Ads I would build a React and TypeScript merchant dashboard." })
    const reasonOf = async (app: ApplicationDetail) => {
      openDocuments(`/applications/${app.id}`, { applications: [app] })
      const text = within(await screen.findByRole("alert")).getByText(/named the employer or the role/).textContent
      cleanup()
      return text
    }
    const a = await reasonOf(employer)
    const b = await reasonOf(role)
    expect(a).toBe(b)
    expect(a).not.toMatch(/Reddit|Frontend Engineer/)
  })

  it("@ac-9.3: a not-confirmed block shows Drove only inside the quoted line", async () => {
    const claim = "Drove the move of the billing service to Kubernetes"
    const { alert } = await openAlert(blocked({ blockedDocument: "resume", blockedClaimCause: "not_confirmed", blockedClaim: claim, blockedClaimTerms: ["drove"], blockedClaimMoreTerms: 0 }))
    const quote = alert.querySelector("blockquote")!
    expect(quote).toHaveTextContent(claim)
    expect((alert.textContent ?? "").replace(quote.textContent ?? "", "")).not.toMatch(/drove/i)
  })
})

describe("QA EPIC-0009: model output stays text (@ac-8.6)", () => {
  it("@ac-8.6 r1: markdown link and emphasis in the paragraph and terms render as text", async () => {
    const paragraph = "I built a React and TypeScript merchant dashboard with **Zorvex** and [Kubra](https://kubra.example)."
    const { alert } = await openAlert(blocked({ blockedClaim: paragraph, blockedClaimCause: "unsupported_terms", blockedClaimTerms: ["Zorvex", "Kubra", "https", "example"], blockedClaimMoreTerms: 0 }))
    expect(alert.querySelector("blockquote")!.textContent).toBe(paragraph)
    expect(alert.querySelectorAll("a, strong, em, script")).toHaveLength(0)
    expect(within(alert).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Zorvex", "Kubra", "https", "example"])
  })

  it("@ac-8.6 r2: a script span is one text term and creates no element", async () => {
    const paragraph = "I built a React and TypeScript merchant dashboard with Zorvex <script>alert(1)</script>"
    const { alert } = await openAlert(blocked({ blockedClaim: paragraph, blockedClaimCause: "unsupported_terms", blockedClaimTerms: ["script>alert(1)</script"], blockedClaimMoreTerms: 0 }))
    expect(within(alert).getByRole("listitem")).toHaveTextContent("script>alert(1)</script")
    expect(alert.querySelector("script")).toBeNull()
  })
})

describe("QA EPIC-0009: Generate again (@ac-11.8, @ac-11.1)", () => {
  it("@ac-11.8: Generate again sits below the alert; pressing it shows the generating state and no alert", async () => {
    const app = blocked({ blockedClaimCause: "unsupported_terms", blockedClaimTerms: ["Zorvex"], blockedClaimMoreTerms: 0 })
    const { user, alert, api } = await openAlert(app)
    const button = screen.getByRole("button", { name: "Generate again" })
    expect(alert.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await user.click(button)
    expect(await screen.findByRole("status")).toHaveTextContent("Writing your resume and cover letter.")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByText("Zorvex")).not.toBeInTheDocument()
    expect(api.requests).toEqual([{ method: "POST", path: `/v1/applications/${app.id}/documents/generate`, body: null }])
  })
})
