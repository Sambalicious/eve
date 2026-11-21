import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import type { AddedFactsView, ApplicationDetail } from "@eve/contracts"
import {
  addedFactsViewSchema,
  applicationAddedFactsConfirmPath,
  applicationAddedFactsPath,
} from "@eve/contracts"
import {
  ADDED_APPLICATION_ID,
  CICD_FACT_ID,
  FIGMA_FACT_ID,
  addedFactsView,
  applicationWithAddedFacts,
  busyGenerating,
  editableWithFacts,
  freshLifted,
  frozenSubmitted,
  noAtsResult,
  oneLinerFact,
  skillCeiling,
  skillOnlyFact,
} from "@/shared/testing/added-facts-fixtures"
import { createAddedFactsApi } from "@/shared/testing/added-facts-api"
import { apiErrorResponse, rankedPosting, server, strongMatch, submission, tailoredDocument } from "@/shared/testing"
import { advance } from "./career-setup-helpers"
import { openDocuments } from "./documents-helpers"

const ATS = { score: 62, total: 9, matched: ["React", "TypeScript"], missing: [], gaps: ["Figma", "design systems"] }

/**
 * The authored fixture `editableWithFacts` fills `addedFactsCited` with whole facts; the contract's
 * `addedFactUsedSchema` is strict, so a detail carrying them fails its own schema. Reduce each entry to
 * the four keys the wire sends (BLOCKER[qa] filed against the fixture).
 */
function citedOnly(view: AddedFactsView): AddedFactsView {
  return {
    ...view,
    addedFactsCited: view.addedFactsCited.map((fact) => ({
      id: fact.id,
      kind: fact.kind,
      text: fact.text,
      role: fact.role === null ? null : { title: fact.role.title, employer: fact.role.employer, period: fact.role.period },
    })),
  }
}

function appWith(view: AddedFactsView, overrides: Partial<ApplicationDetail> = {}): ApplicationDetail {
  return applicationWithAddedFacts(view, {
    documents: [
      { ...tailoredDocument(ADDED_APPLICATION_ID, "resume"), ats: ATS, addedFactsUsed: view.addedFactsCited },
      tailoredDocument(ADDED_APPLICATION_ID, "cover_letter"),
    ],
    ...overrides,
  })
}

/** Opens the Application page with the added-facts view, its five MSW routes and the view in the detail. */
function openWith(viewInput: AddedFactsView, appOverrides: Partial<ApplicationDetail> = {}, options: { fakeTimers?: boolean } = {}) {
  const view = citedOnly(viewInput)
  const app = appWith(view, appOverrides)
  const added = createAddedFactsApi({ views: { [ADDED_APPLICATION_ID]: view } })
  server.use(...added.handlers)
  const opened = openDocuments(`/applications/${app.id}`, { applications: [app] }, { fakeTimers: options.fakeTimers })
  return { ...opened, added, app }
}

const atsCard = () => screen.findByRole("region", { name: /^ATS match/ })

async function openSection() {
  await waitFor(() => expect(document.getElementById("added-facts")).not.toBeNull())
  return document.getElementById("added-facts") as HTMLElement
}

describe("FEAT-0017 ATS card: tick gap terms", () => {
  it("@ac-1.1 the gap terms are tick boxes under the shared Affirmation, and the comma list is gone", async () => {
    openWith(addedFactsView({ postingGaps: { available: true, terms: ["Figma", "design systems", "CI/CD pipelines"] } }))
    const card = await atsCard()
    expect(within(card).getByText(/^Not in your profile/)).toBeVisible()
    expect(within(card).getByText("Tick the ones you have used.")).toBeVisible()
    expect(within(card).getByText("I have done this in real work, a project or study. It is not something I plan to learn.")).toBeVisible()
    for (const term of ["Figma", "design systems", "CI/CD pipelines"]) {
      expect(within(card).getByRole("checkbox", { name: `${term}, I have used this` })).toBeVisible()
    }
    expect(within(card).queryByText("Figma, design systems", { exact: false })).not.toBeInTheDocument()
    expect(within(card).queryByRole("button", { name: /^Add \d skill/ })).not.toBeInTheDocument()
  })

  it("@ac-1.2 ticking one term posts one skill-only fact, moves it to Added for this job and announces it", async () => {
    const { added } = openWith(addedFactsView({ postingGaps: { available: true, terms: ["Figma", "design systems"] } }))
    const card = await atsCard()
    within(card).getByRole("checkbox", { name: "Figma, I have used this" }).click()

    const save = await within(card).findByRole("button", { name: "Add 1 skill to this job" })
    expect(within(card).getByRole("checkbox", { name: "Also add to my Career Profile (needs your approval)", description: "Figma" })).not.toBeChecked()
    save.click()

    await waitFor(() => expect(added.state.requests.some((request) => request.method === "POST")).toBe(true))
    expect(added.state.requests.find((request) => request.method === "POST")?.body).toEqual({
      expectedVersion: 0,
      items: [{ kind: "skill_only", term: "Figma", affirmed: true, saveToProfile: false }],
    })

    const section = await openSection()
    expect(await within(section).findByText("Figma")).toBeVisible()
    expect(within(section).getByText("skill only")).toBeVisible()
    expect(within(section).getByText(/used in the documents/i)).toBeVisible()
    expect(within(section).getByText("0 of 10 sentences")).toBeVisible()
    await waitFor(() => expect(within(section).getByRole("status")).toHaveTextContent("1 skill added to this job"))
    await waitFor(() => expect(within(card).queryByRole("checkbox", { name: "Figma, I have used this" })).not.toBeInTheDocument())
  })

  it("@ac-6.1 each ticked term carries its own profile checkbox, and the save sends it", async () => {
    const { added } = openWith(addedFactsView({ postingGaps: { available: true, terms: ["Figma", "design systems"] } }))
    const card = await atsCard()
    within(card).getByRole("checkbox", { name: "Figma, I have used this" }).click()
    within(card).getByRole("checkbox", { name: "design systems, I have used this" }).click()
    within(card).getByRole("checkbox", { name: "Also add to my Career Profile (needs your approval)", description: "design systems" }).click()
    within(card).getByRole("button", { name: "Add 2 skills to this job" }).click()

    await waitFor(() => expect(added.state.requests.some((request) => request.method === "POST")).toBe(true))
    expect(added.state.requests.find((request) => request.method === "POST")?.body).toMatchObject({
      expectedVersion: 0,
      items: [
        { kind: "skill_only", term: "Figma", affirmed: true },
        { kind: "skill_only", term: "design systems", affirmed: true, saveToProfile: true },
      ],
    })
  })

  it("@ac-1.7 the forty-first skill-only fact is refused with C-AF-52 and keeps the ticks", async () => {
    openWith(skillCeiling())
    const card = await atsCard()
    within(card).getByRole("checkbox", { name: "term 40, I have used this" }).click()
    within(card).getByRole("button", { name: "Add 1 skill to this job" }).click()
    expect(await within(card).findByText("You can add up to 40 skills for one job.")).toBeVisible()
  })

  it("@ac-4.2 a Frozen Application shows the terms read-only with C-AF-13 and no tick control", async () => {
    openWith(frozenSubmitted())
    const card = await atsCard()
    expect(within(card).getByText("design systems")).toBeVisible()
    expect(within(card).queryAllByRole("checkbox")).toHaveLength(0)
    expect(within(card).getByText("Terms can't be ticked: this Application is locked.")).toBeVisible()
    const section = await openSection()
    expect(within(section).getByText("Added facts are locked: this Application was submitted or marked complete.")).toBeVisible()
    expect(within(section).queryByRole("button", { name: "Add a fact" })).not.toBeInTheDocument()
    expect(within(section).queryByRole("button", { name: /^Remove,/ })).not.toBeInTheDocument()
  })

  it("@ac-4.4 while documents generate the card says to wait and offers no ticks", async () => {
    openWith(busyGenerating({ postingGaps: { available: true, terms: ["Figma"] } }))
    const card = await atsCard()
    expect(within(card).getByText("Wait for the documents to finish, then tick terms.")).toBeVisible()
    expect(within(card).queryAllByRole("checkbox")).toHaveLength(0)
    const section = await openSection()
    expect(within(section).getByText("Wait until the documents finish, then change facts.")).toBeVisible()
  })

  it("@ac-1.5 with no ATS result there is no gap list and Add a fact still works", async () => {
    openWith(noAtsResult())
    const card = await atsCard()
    expect(within(card).queryByText(/^Not in your profile/)).not.toBeInTheDocument()
    const section = await openSection()
    expect(within(section).getByText("Terms from the posting appear after Eve writes the documents. You can add a fact now.")).toBeVisible()
    expect(within(section).getByRole("button", { name: "Add a fact" })).toBeVisible()
  })

  it("@ac-1.3 the card lists what was added and links to the section", async () => {
    openWith(editableWithFacts())
    const card = await atsCard()
    expect(within(card).getByText(/^Added for this job: /)).toBeVisible()
    expect(within(card).getByRole("link", { name: "Manage added facts" }).getAttribute("href")).toContain("#added-facts")
    expect(within(card).getByText("This score is from before your added facts.")).toBeVisible()
    // Design review [6b] note: C-AF-15 sits directly under the score, above the keyword lines.
    const stale = within(card).getByText("This score is from before your added facts.")
    const score = within(card).getByRole("heading", { name: /^ATS match 62%/ })
    const keywords = within(card).getByText(/^In this resume:/)
    expect(score.compareDocumentPosition(stale) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(stale.compareDocumentPosition(keywords) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe("FEAT-0017 generating: the view follows the Application in and out", () => {
  it("regenerating freezes the Added section, and finishing makes it editable and fresh again with no reload", async () => {
    const gaps = { available: true as const, terms: ["Figma", "design systems"] }
    const before = citedOnly(addedFactsView({ postingGaps: gaps }))
    // The api derives the view from the Application's state and the new documents: busy generating,
    // then editable with the Figma skill now added and the gap list without it.
    const after = citedOnly(
      addedFactsView({
        version: 1,
        facts: [skillOnlyFact()],
        counts: { oneLiner: 0, skillOnly: 1 },
        postingGaps: { available: true, terms: ["design systems"] },
      })
    )
    const app = appWith(before)
    let generated = false
    const added = createAddedFactsApi({ views: { [ADDED_APPLICATION_ID]: before } })
    server.use(...added.handlers)
    server.use(
      http.get(applicationAddedFactsPath(ADDED_APPLICATION_ID), () =>
        HttpResponse.json(addedFactsViewSchema.parse(generated ? after : app.state === "generating" ? busyGenerating({ postingGaps: gaps }) : before))
      )
    )
    // The completion read writes documents the ATS card can score, as a real generation does.
    const { user } = openDocuments(
      `/applications/${app.id}`,
      {
        applications: [app],
        nextGeneration: (current) => {
          generated = true
          return appWith(after, {
            id: current.id,
            addedFacts: after,
            documents: [{ ...tailoredDocument(current.id, "resume"), ats: ATS }, tailoredDocument(current.id, "cover_letter")],
          })
        },
      },
      { fakeTimers: true }
    )

    const section = await openSection()
    expect(within(section).getByRole("button", { name: "Add a fact" })).toBeVisible()
    expect(within(await atsCard()).getByRole("checkbox", { name: "Figma, I have used this" })).toBeVisible()

    await user.click(await screen.findByRole("button", { name: "Generate again" }))

    // Generation starts: the detail learned it, so the Added view must freeze too.
    expect(await within(section).findByText("Wait until the documents finish, then change facts.")).toBeVisible()
    expect(within(section).queryByRole("button", { name: "Add a fact" })).not.toBeInTheDocument()

    // Generation ends: the view comes back editable and shows what the generation recorded.
    await advance(5000)
    expect(await within(section).findByRole("button", { name: "Add a fact" })).toBeVisible()
    expect(within(section).getByText("Figma")).toBeVisible()
    expect(within(section).getByText("0 of 10 sentences")).toBeVisible()
    const fresh = await atsCard()
    expect(within(fresh).getByRole("checkbox", { name: "design systems, I have used this" })).toBeVisible()
    expect(within(fresh).queryByRole("checkbox", { name: "Figma, I have used this" })).not.toBeInTheDocument()
  })
})

describe("FEAT-0017 Added for this job: the form and rows", () => {
  it("@ac-2.2 free entry adds a sentence with a role, the Affirmation and the profile box", async () => {
    const { added } = openWith(addedFactsView())
    const section = await openSection()
    const user = userEvent.setup()
    await user.click(within(section).getByRole("button", { name: "Add a fact" }))
    expect(within(section).getByRole("heading", { name: "Add a fact" })).toBeVisible()
    expect(within(section).getByText("Say what you did and, if you can, with what and where. For example: Set up GitHub Actions CI/CD at Acme.")).toBeVisible()
    expect(within(section).getByLabelText("What you did")).toHaveValue("")
    expect(within(section).getByLabelText("Role")).toHaveValue("")
    const affirmation = "I have done this in real work, a project or study. It is not something I plan to learn."
    expect(within(section).getByRole("checkbox", { name: affirmation })).not.toBeChecked()
    expect(within(section).getByRole("checkbox", { name: "Also add to my Career Profile (needs your approval)" })).not.toBeChecked()

    await user.type(within(section).getByLabelText("What you did"), "Mentored 3 interns on code review at Acme")
    await user.selectOptions(within(section).getByLabelText("Role"), "sec-exp-2")
    await user.click(within(section).getByRole("checkbox", { name: affirmation }))
    await user.click(within(section).getByRole("button", { name: "Add fact" }))

    await waitFor(() => expect(added.state.requests.some((request) => request.method === "POST")).toBe(true))
    expect(added.state.requests.find((request) => request.method === "POST")?.body).toEqual({
      expectedVersion: 0,
      items: [{ kind: "one_liner", text: "Mentored 3 interns on code review at Acme", roleSectionId: "sec-exp-2", affirmed: true, saveToProfile: false }],
    })
    expect(await within(section).findByText("Mentored 3 interns on code review at Acme")).toBeVisible()
    expect(within(section).getByText("sentence")).toBeVisible()
    expect(within(section).getByText("1 of 10 sentences")).toBeVisible()
  })

  it("@ac-2.5 the count reads n of 300 and a 301-character paste is refused with C-AF-56, kept", async () => {
    const { added } = openWith(addedFactsView())
    const section = await openSection()
    const user = userEvent.setup()
    await user.click(within(section).getByRole("button", { name: "Add a fact" }))
    const textarea = within(section).getByLabelText("What you did")
    await user.click(textarea)
    await user.paste("x".repeat(300))
    expect(within(section).getByText("300 of 300")).toBeVisible()
    await user.clear(textarea)
    await user.click(textarea)
    await user.paste(`x${"y".repeat(300)}`)
    await user.selectOptions(within(section).getByLabelText("Role"), "sec-exp-1")
    await user.click(within(section).getByRole("checkbox", { name: "I have done this in real work, a project or study. It is not something I plan to learn." }))
    await user.click(within(section).getByRole("button", { name: "Add fact" }))
    expect(await within(section).findByText("That is 301 characters. The limit is 300.")).toBeVisible()
    expect(within(section).getByLabelText("What you did")).toHaveValue(`x${"y".repeat(300)}`)
    expect(added.state.views[ADDED_APPLICATION_ID]?.facts).toHaveLength(0)
  })

  it("@ac-2.1 a sentence saved without a role or the Affirmation shows both field messages", async () => {
    const { added } = openWith(addedFactsView())
    const section = await openSection()
    const user = userEvent.setup()
    await user.click(within(section).getByRole("button", { name: "Add a fact" }))
    await user.type(within(section).getByLabelText("What you did"), "Mentored 3 interns on code review at Acme")
    await user.click(within(section).getByRole("button", { name: "Add fact" }))
    expect(await within(section).findByText("Choose a role.")).toBeVisible()
    expect(within(section).getByText("Tick the box to say you have done this.")).toBeVisible()
    expect(added.state.views[ADDED_APPLICATION_ID]?.facts).toHaveLength(0)
  })

  it("@ac-3.3 and @ac-2.5 the server's aspiration and contact refusals reach a field and the text is kept", async () => {
    const { added } = openWith(addedFactsView())
    server.use(
      http.post(
        applicationAddedFactsPath(ADDED_APPLICATION_ID),
        () =>
          HttpResponse.json(
            {
              error: {
                code: "added_facts_invalid",
                message: "Check the highlighted fields. Nothing was saved.",
                fieldErrors: [
                  { source: "added_facts", field: "text", position: 1, problem: "aspiration_text" },
                  { source: "added_facts", field: "text", position: 1, problem: "contact_detail" },
                ],
              },
            },
            { status: 422 }
          ),
        { once: true }
      )
    )
    const section = await openSection()
    const user = userEvent.setup()
    await user.click(within(section).getByRole("button", { name: "Add a fact" }))
    await user.type(within(section).getByLabelText("What you did"), "I want to learn Storybook at Acme")
    await user.selectOptions(within(section).getByLabelText("Role"), "sec-exp-1")
    await user.click(within(section).getByRole("checkbox", { name: "I have done this in real work, a project or study. It is not something I plan to learn." }))
    await user.click(within(section).getByRole("button", { name: "Add fact" }))
    expect(await within(section).findByText("Write only what you have done.")).toBeVisible()
    expect(within(section).getByLabelText("What you did")).toHaveValue("I want to learn Storybook at Acme")
    expect(added.state.views[ADDED_APPLICATION_ID]?.facts).toHaveLength(0)
  })

  it("@ac-1.4 Add a sentence upgrades the ticked fact in place through PATCH", async () => {
    const view = addedFactsView({
      version: 1,
      facts: [skillOnlyFact()],
      counts: { oneLiner: 0, skillOnly: 1 },
      postingGaps: { available: true, terms: ["design systems"] },
    })
    const { added } = openWith(view)
    const section = await openSection()
    const user = userEvent.setup()
    await user.click(within(section).getByRole("button", { name: "Add a sentence about Figma" }))
    expect(within(section).getByRole("heading", { name: "Add a sentence" })).toBeVisible()
    expect(within(section).getByText("About Figma")).toBeVisible()
    expect(within(section).queryAllByRole("checkbox")).toHaveLength(0)
    expect(within(section).getByText("I have done this in real work, a project or study. It is not something I plan to learn.")).toBeVisible()
    await user.type(within(section).getByLabelText("What you did"), "Designed 12 Figma prototypes for checkout at Acme")
    await user.selectOptions(within(section).getByLabelText("Role"), "sec-exp-1")
    await user.click(within(section).getByRole("button", { name: "Add fact" }))

    await waitFor(() => expect(added.state.requests.some((request) => request.method === "PATCH")).toBe(true))
    expect(added.state.requests.find((request) => request.method === "PATCH")?.body).toEqual({
      expectedVersion: 1,
      text: "Designed 12 Figma prototypes for checkout at Acme",
      roleSectionId: "sec-exp-1",
    })
    expect(await within(section).findByText("Designed 12 Figma prototypes for checkout at Acme")).toBeVisible()
    expect(within(section).queryByText("skill only")).not.toBeInTheDocument()
    expect(within(section).getByText("sentence")).toBeVisible()
  })

  it("@ac-2.3 editing a sentence that does not name its term shows C-AF-54", async () => {
    const view = addedFactsView({ version: 1, facts: [oneLinerFact()], counts: { oneLiner: 1, skillOnly: 0 } })
    openWith(view)
    const section = await openSection()
    const user = userEvent.setup()
    await user.click(within(section).getByRole("button", { name: "Edit, Set up GitHub Actions CI/CD pipelines at Acme" }))
    expect(within(section).getByRole("heading", { name: "Edit sentence" })).toBeVisible()
    const textarea = within(section).getByLabelText("What you did")
    await user.clear(textarea)
    await user.type(textarea, "Set up the release workflow at Acme")
    await user.click(within(section).getByRole("button", { name: "Save" }))
    expect(await within(section).findByText("Say what you did with CI/CD pipelines.")).toBeVisible()
  })

  it("@ac-4.1 Remove takes one tap, no dialog, and returns the term to the gap list", async () => {
    const view = addedFactsView({
      version: 1,
      facts: [skillOnlyFact()],
      counts: { oneLiner: 0, skillOnly: 1 },
      postingGaps: { available: true, terms: ["design systems"] },
    })
    const { added } = openWith(view)
    const section = await openSection()
    const user = userEvent.setup()
    await user.click(within(section).getByRole("button", { name: "Remove, Figma" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    await waitFor(() => expect(added.state.views[ADDED_APPLICATION_ID]?.facts).toHaveLength(0))
    await waitFor(() => expect(within(section).queryByText("Figma")).not.toBeInTheDocument())
    await waitFor(() => expect(within(section).getByRole("status")).toHaveTextContent("Fact removed. Figma is back in the list."))
    const card = await atsCard()
    expect(await within(card).findByRole("checkbox", { name: "Figma, I have used this" })).toBeVisible()
  })

  it("@ac-4.5 a conflicting change shows C-AF-57 and reloads the list", async () => {
    const view = addedFactsView({ version: 1, facts: [skillOnlyFact()], counts: { oneLiner: 0, skillOnly: 1 } })
    const { added } = openWith(view)
    const section = await openSection()
    // Another tab removed it first: the counter moved, so this page's expectedVersion is stale.
    added.state.views[ADDED_APPLICATION_ID] = { ...view, version: 2, facts: [], counts: { oneLiner: 0, skillOnly: 0 } }
    const user = userEvent.setup()
    await user.click(within(section).getByRole("button", { name: "Remove, Figma" }))
    expect(
      await within(section).findByText("This job's facts changed elsewhere. The list is refreshed. Check it, then save again.")
    ).toBeVisible()
    await waitFor(() => expect(within(section).queryByText("Figma")).not.toBeInTheDocument())
  })

  it("@ac-2.4 with no experience role the form says so, links to the profile and keeps ticks", async () => {
    openWith(addedFactsView({ roles: [], postingGaps: { available: true, terms: ["Figma"] } }))
    const section = await openSection()
    const user = userEvent.setup()
    const emptyNote = within(section).getByText("Nothing added yet. Tick terms on the score card, or add a fact.")
    expect(emptyNote).toBeVisible()
    await user.click(within(section).getByRole("button", { name: "Add a fact" }))
    expect(within(section).getByText("Add a role to your Career Profile first. Sentences print under a role. Ticking terms still works.")).toBeVisible()
    const link = within(section).getByRole("link", { name: "Go to Career Profile" })
    expect(link).toHaveAttribute("href", "/profile")
    // Design review [6b] notes: the empty note steps aside while the form is open, and the no-role
    // form's first control (the link) takes the focus its missing text field cannot.
    expect(emptyNote).not.toBeInTheDocument()
    await waitFor(() => expect(link).toHaveFocus())
    expect(within(section).queryByLabelText("What you did")).not.toBeInTheDocument()
    expect(within(await atsCard()).getByRole("checkbox", { name: "Figma, I have used this" })).toBeVisible()

    await user.click(within(section).getByRole("button", { name: "Cancel" }))
    expect(await within(section).findByText("Nothing added yet. Tick terms on the score card, or add a fact.")).toBeVisible()
  })

  it("design review [6b] the FEAT-0017 actions grow to 44px on coarse pointers", async () => {
    openWith(addedFactsView({ version: 1, facts: [oneLinerFact(), skillOnlyFact()], counts: { oneLiner: 1, skillOnly: 1 } }))
    const section = await openSection()
    const actions = [
      within(section).getByRole("button", { name: "Add a fact" }),
      ...within(section).getAllByRole("button", { name: /^Edit, / }),
      ...within(section).getAllByRole("button", { name: /^Remove, / }),
      ...within(section).getAllByRole("button", { name: /^Add a sentence about / }),
    ]
    for (const action of actions) expect(action.className).toContain("pointer-coarse:min-h-11")
  })

  it("design review [6b] at 10 of 10 the C-AF-55 line is a status region re-announced as the form opens", async () => {
    openWith(addedFactsView({ counts: { oneLiner: 10, skillOnly: 0 } }))
    const section = await openSection()
    const line = within(section).getByText("You can add up to 10 sentences for one job.")
    expect(line).toHaveAttribute("role", "status")
    const user = userEvent.setup()
    await user.click(within(section).getByRole("button", { name: "Add a fact" }))
    expect(within(section).getByRole("heading", { name: "Add a fact" })).toBeVisible()
    // A fresh status node is what makes a screen reader speak the line again as the form appears.
    const reopened = within(section).getByText("You can add up to 10 sentences for one job.")
    expect(reopened).toHaveAttribute("role", "status")
    expect(reopened).not.toBe(line)
    expect(line.isConnected).toBe(false)
  })

  it("@ac-6.6 the profile note shows under Remove only when the box was ticked", async () => {
    const withProfile = addedFactsView({
      version: 1,
      facts: [skillOnlyFact({ saveToProfile: true, profile: { status: "draft", version: 5 } })],
      counts: { oneLiner: 0, skillOnly: 1 },
    })
    openWith(withProfile)
    const section = await openSection()
    expect(within(section).getByText("Removing it here doesn't remove it from your Career Profile.")).toBeVisible()
    expect(within(section).getByText("also in your Career Profile draft")).toBeVisible()
  })
})

describe("FEAT-0017 the blocked alert's action", () => {
  it("@ac-2.7 unsupported terms offer Add a fact about {term}, opening an empty form with C-AF-41", async () => {
    const view = addedFactsView()
    const app = appWith(view, {
      state: "documents_blocked",
      blockedDocument: "cover_letter",
      blockedClaim: "I built the Storybook library at Acme.",
      blockedClaimCause: "unsupported_terms",
      blockedClaimTerms: ["Storybook"],
      blockedClaimMoreTerms: 0,
      documents: [],
    })
    const added = createAddedFactsApi({ views: { [ADDED_APPLICATION_ID]: view } })
    server.use(...added.handlers)
    openDocuments(`/applications/${app.id}`, { applications: [app] })

    const alert = await screen.findByRole("alert")
    const action = within(alert).getByRole("button", { name: "Add a fact about Storybook" })
    // Design review [6b] note: it must read as a button, not as red label text, and grow on touch.
    expect(action.className).toContain("underline")
    expect(action.className).toContain("pointer-coarse:min-h-11")
    action.click()
    const section = await openSection()
    expect(await within(section).findByText("The documents mentioned Storybook. If you have done this, say what you did.")).toBeVisible()
    expect(within(section).getByLabelText("What you did")).toHaveValue("")
    await waitFor(() => expect(within(section).getByRole("status")).toHaveTextContent("Add a fact form opened for Storybook."))
  })

  it("@ac-2.7 no action is offered for a cause adding a fact cannot fix", async () => {
    const view = addedFactsView()
    const app = appWith(view, {
      state: "documents_blocked",
      blockedDocument: "cover_letter",
      blockedClaim: "You can reach me at sam@example.com.",
      blockedClaimCause: "contact_detail",
      blockedClaimTerms: null,
      blockedClaimMoreTerms: null,
      documents: [],
    })
    const added = createAddedFactsApi({ views: { [ADDED_APPLICATION_ID]: view } })
    server.use(...added.handlers)
    openDocuments(`/applications/${app.id}`, { applications: [app] })
    const alert = await screen.findByRole("alert")
    expect(within(alert).queryByRole("button", { name: /^Add a fact/ })).not.toBeInTheDocument()
  })

  it("@ac-1.8 and @ac-4.2 the action is hidden on a Frozen Application", async () => {
    const view = frozenSubmitted()
    const app = appWith(view, {
      state: "documents_blocked",
      blockedDocument: "resume",
      blockedClaim: "I built the Storybook library.",
      blockedClaimCause: "unsupported_terms",
      blockedClaimTerms: ["Storybook"],
      blockedClaimMoreTerms: 0,
      documents: [],
    })
    const added = createAddedFactsApi({ views: { [ADDED_APPLICATION_ID]: view } })
    server.use(...added.handlers)
    openDocuments(`/applications/${app.id}`, { applications: [app] })
    const alert = await screen.findByRole("alert")
    expect(within(alert).queryByRole("button", { name: /^Add a fact/ })).not.toBeInTheDocument()
  })
})

describe("FEAT-0017 Cancel and Escape return focus to the form's opener", () => {
  it("from the header's Add a fact, Escape and Cancel focus that button", async () => {
    openWith(addedFactsView())
    const section = await openSection()
    const user = userEvent.setup()
    const add = within(section).getByRole("button", { name: "Add a fact" })

    await user.click(add)
    await user.click(within(section).getByLabelText("What you did"))
    await user.keyboard("{Escape}")
    await waitFor(() => expect(add).toHaveFocus())
    expect(within(section).queryByRole("heading", { name: "Add a fact" })).not.toBeInTheDocument()

    await user.click(add)
    await user.click(within(section).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(add).toHaveFocus())
    expect(within(section).queryByRole("heading", { name: "Add a fact" })).not.toBeInTheDocument()
  })

  it("from a row's Edit, Escape and Cancel focus that Edit button", async () => {
    openWith(addedFactsView({ version: 1, facts: [oneLinerFact()], counts: { oneLiner: 1, skillOnly: 0 } }))
    const section = await openSection()
    const user = userEvent.setup()
    const edit = within(section).getByRole("button", { name: "Edit, Set up GitHub Actions CI/CD pipelines at Acme" })

    await user.click(edit)
    await user.click(within(section).getByLabelText("What you did"))
    await user.keyboard("{Escape}")
    await waitFor(() => expect(edit).toHaveFocus())
    expect(within(section).queryByRole("heading", { name: "Edit sentence" })).not.toBeInTheDocument()

    await user.click(edit)
    await user.click(within(section).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(edit).toHaveFocus())
  })

  it("from a row's Add a sentence, Escape and Cancel focus that button", async () => {
    openWith(addedFactsView({ version: 1, facts: [skillOnlyFact()], counts: { oneLiner: 0, skillOnly: 1 } }))
    const section = await openSection()
    const user = userEvent.setup()
    const addSentence = within(section).getByRole("button", { name: "Add a sentence about Figma" })

    await user.click(addSentence)
    await user.click(within(section).getByLabelText("What you did"))
    await user.keyboard("{Escape}")
    await waitFor(() => expect(addSentence).toHaveFocus())
    expect(within(section).queryByRole("heading", { name: "Add a sentence" })).not.toBeInTheDocument()

    await user.click(addSentence)
    await user.click(within(section).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(addSentence).toHaveFocus())
  })

  it("from the blocked alert's Add a fact about {term}, Escape and Cancel focus that button", async () => {
    const view = addedFactsView()
    const app = appWith(view, {
      state: "documents_blocked",
      blockedDocument: "cover_letter",
      blockedClaim: "I built the Storybook library at Acme.",
      blockedClaimCause: "unsupported_terms",
      blockedClaimTerms: ["Storybook"],
      blockedClaimMoreTerms: 0,
      documents: [],
    })
    const added = createAddedFactsApi({ views: { [ADDED_APPLICATION_ID]: view } })
    server.use(...added.handlers)
    openDocuments(`/applications/${app.id}`, { applications: [app] })

    const alert = await screen.findByRole("alert")
    const opener = within(alert).getByRole("button", { name: "Add a fact about Storybook" })
    const section = await openSection()
    const user = userEvent.setup()

    await user.click(opener)
    await within(section).findByRole("heading", { name: "Add a fact" })
    await user.click(within(section).getByLabelText("What you did"))
    await user.keyboard("{Escape}")
    await waitFor(() => expect(opener).toHaveFocus())
    expect(within(section).queryByRole("heading", { name: "Add a fact" })).not.toBeInTheDocument()

    await user.click(opener)
    await within(section).findByRole("heading", { name: "Add a fact" })
    await user.click(within(section).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(opener).toHaveFocus())
  })
})

describe("FEAT-0017 stale notice, the lift and the Match panel", () => {
  it("@ac-5.6 and @ac-5.7 a changed set shows C-AF-60 and C-AF-61 above Generate again", async () => {
    openWith(editableWithFacts())
    expect(await screen.findByText("Your added facts changed after these documents were written. Regenerate to use them.")).toBeVisible()
    expect(screen.getByText("It won't be submitted automatically until you generate again.")).toBeVisible()
  })

  it("@ac-7.6 the lift panel names what lifted it and offers the one tap", async () => {
    const { added } = openWith(freshLifted({ confirmation: { state: "required", voided: false, confirmedAt: null } }))
    const panel = await screen.findByRole("region", { name: "Strong match with your added facts" })
    expect(within(panel).getByText("Match with your Career Profile: 5/9")).toBeVisible()
    expect(within(panel).getByText("With the facts you added: 7/9")).toBeVisible()
    expect(within(panel).getByText("What lifted it")).toBeVisible()
    expect(within(panel).getByText("It joins the automatic queue. No new documents are written.")).toBeVisible()
    // Design review [6b] note: coarse pointers get at least 44px.
    expect(within(panel).getByRole("button", { name: "Submit with your added skills" }).className).toContain("pointer-coarse:min-h-11")
    within(panel).getByRole("button", { name: "Submit with your added skills" }).click()
    await waitFor(() => expect(added.state.requests.some((request) => request.path.endsWith("/added-facts/confirm"))).toBe(true))
    expect(added.state.requests.find((request) => request.path.endsWith("/added-facts/confirm"))?.body).toEqual({ expectedVersion: 2 })
    expect(await within(panel).findByText("Confirmed. It joins the automatic queue.")).toBeVisible()
  })

  it("CR-2 a 409 application_state_conflict from confirm reloads and shows C-AF-57, not a Try again loop", async () => {
    const view = citedOnly(freshLifted({ confirmation: { state: "required", voided: false, confirmedAt: null } }))
    const { added } = openWith(view)
    let reads = 0
    server.use(
      http.post(applicationAddedFactsConfirmPath(ADDED_APPLICATION_ID), () => apiErrorResponse("application_state_conflict")),
      http.get(applicationAddedFactsPath(ADDED_APPLICATION_ID), () => {
        reads += 1
        return HttpResponse.json(addedFactsViewSchema.parse(added.state.views[ADDED_APPLICATION_ID]))
      })
    )
    const panel = await screen.findByRole("region", { name: "Strong match with your added facts" })
    const user = userEvent.setup()
    const before = reads

    await user.click(within(panel).getByRole("button", { name: "Submit with your added skills" }))

    expect(
      await within(panel).findByText("This job's facts changed elsewhere. The list is refreshed. Check it, then save again.")
    ).toBeVisible()
    expect(within(panel).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument()
    expect(within(panel).queryByText("Eve couldn't save that. Nothing you entered was lost. Try again.")).not.toBeInTheDocument()
    await waitFor(() => expect(reads).toBeGreaterThan(before))
  })

  it("@ac-7.6 with stale documents the button is disabled and C-AF-67 explains why", async () => {
    openWith(editableWithFacts())
    const panel = await screen.findByRole("region", { name: "Strong match with your added facts" })
    expect(within(panel).getByRole("button", { name: "Submit with your added skills" })).toHaveAttribute("aria-disabled", "true")
    expect(within(panel).getByText("Generate again first, so the documents match.")).toBeVisible()
  })

  it("@ac-7.7 a voided confirmation says so (C-AF-68)", async () => {
    openWith(freshLifted())
    const panel = await screen.findByRole("region", { name: "Strong match with your added facts" })
    expect(within(panel).getByText("Your confirmation was cleared because the facts changed. Generate again, then confirm again.")).toBeVisible()
  })

  it("@ac-7.6 a Frozen Application shows no lift action", async () => {
    openWith(frozenSubmitted())
    await atsCard()
    expect(screen.queryByRole("button", { name: "Submit with your added skills" })).not.toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "Strong match with your added facts" })).not.toBeInTheDocument()
  })

  it("@ac-7.4 the Match panel shows both numbers and the coverage, skill-only marked", async () => {
    const view = citedOnly(editableWithFacts())
    const app = appWith(view)
    const posting = rankedPosting({ id: app.jobPostingId, match: strongMatch() })
    const added = createAddedFactsApi({ views: { [ADDED_APPLICATION_ID]: view } })
    server.use(...added.handlers)
    openDocuments(`/applications/${app.id}`, { applications: [app] }, { discovery: { postings: [posting] } })

    const panel = await screen.findByRole("region", { name: "Match" })
    expect(await within(panel).findByText("Match with your Career Profile: 5/9")).toBeVisible()
    expect(within(panel).getByText("With the facts you added: 7/9")).toBeVisible()
    expect(within(panel).getByText("What your added facts cover")).toBeVisible()
    expect(within(panel).getByText("Build and maintain our Figma-based design handoff")).toBeVisible()
    expect(within(panel).getAllByText("skill only").length).toBeGreaterThan(0)
  })

  it("@ac-5.10 and 9.5 a sent Application's evidence lists the added facts used (C-AF-89)", async () => {
    const view = citedOnly(editableWithFacts({ documentsStale: false }))
    const app = appWith(view, {
      documents: [
        { ...tailoredDocument(ADDED_APPLICATION_ID, "resume"), ats: ATS, addedFactsUsed: [{ id: FIGMA_FACT_ID, kind: "skill_only", text: "Figma", role: null }] },
        {
          ...tailoredDocument(ADDED_APPLICATION_ID, "cover_letter"),
          addedFactsUsed: [{ id: CICD_FACT_ID, kind: "one_liner", text: "Set up GitHub Actions CI/CD pipelines at Acme", role: null }],
        },
      ],
    })
    const added = createAddedFactsApi({ views: { [ADDED_APPLICATION_ID]: view } })
    server.use(
      ...added.handlers,
      http.get("/v1/applications/:id/submission", () => HttpResponse.json(submission({ state: "manual", manualCompletedAt: "2026-11-21T10:00:00.000Z" })))
    )
    openDocuments(`/applications/${app.id}`, { applications: [app] })
    const heading = await screen.findByText("Added facts used")
    expect(heading).toBeVisible()
    const card = heading.closest("[data-slot='card']") as HTMLElement
    expect(within(card).getByText("Figma")).toBeVisible()
    expect(within(card).getByText("Set up GitHub Actions CI/CD pipelines at Acme")).toBeVisible()
  })
})
