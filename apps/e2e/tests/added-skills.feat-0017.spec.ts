import { type Page, expect, test } from "@playwright/test"

import {
  LIFTING_FACTS,
  addedFactsOf,
  applicationRow,
  confirmThroughPage,
  forged,
  resetAddedSkills,
  seedAddedSkillsApplication,
  setDocumentsSnapshot,
  setNoExperienceProfile,
} from "../support/added-skills-db.ts"
import { signIn } from "../support/db.ts"
import { ADA, BOLA } from "../support/stack.ts"

/**
 * FEAT-0017 QA authoring, step [5e]: job added skills, web-owned and both-owned scenarios.
 * Sources: `gherkin/added-skills-*.feature`, `design-spec.r1.md` (blueprints 1 to 9), `copy-deck.md`
 * (keys C-AF-n, including Addendum r1), `api-contract.md` v1.32.0.
 * The real web app against the real api and Postgres, BOLA's own Career Profile so the fixtures are isolated.
 * Strings are byte for byte from the copy deck, kept here so a wrong string in the product fails the test.
 * Locators by role and accessible name only; the Added section is `#added-facts` (design spec C-AF-16).
 *
 * Run with ADDED_FACTS_ENABLED=1 (support/global-setup.ts sets it). Expected red until the candidate lands.
 */
const COPY = {
  addedHeading: "Added for this job", // C-AF-16
  addedDescription: "Things you have really done, for this job only.", // C-AF-17
  addFact: "Add a fact", // C-AF-18
  manage: "Manage added facts", // C-AF-12
  notInProfile: /^Not in your profile/, // C-AF-1
  tickInstruction: "Tick the ones you have used.", // C-AF-2
  affirmation: "I have done this in real work, a project or study. It is not something I plan to learn.", // C-AF-3
  tickName: (term: string) => `${term}, I have used this`, // C-AF-74
  addSkills: (n: number) => `Add ${n} ${n === 1 ? "skill" : "skills"} to this job`, // C-AF-4
  clearTicks: "Clear ticks", // C-AF-5
  addToProfile: "Also add to my Career Profile (needs your approval)", // C-AF-6
  profileChoiceDescription: (term: string) => term, // C-AF-7 r2: the description is the term alone
  allAdded: "Every missing term is added for this job.", // C-AF-9
  addedSummary: (terms: string) => `Added for this job: ${terms}`, // C-AF-10
  tickReadOnly: "Terms can't be ticked: this Application is locked.", // C-AF-13
  busy: "Wait for the documents to finish, then tick terms.", // C-AF-14
  skillOnly: "skill only", // C-AF-22
  sentence: "sentence", // C-AF-23
  usedInDocuments: "Used in the documents", // C-AF-26
  notUsed: "Not used in the documents yet", // C-AF-27
  draftMarker: "also in your Career Profile draft", // C-AF-28.draft
  draftFull: "Saved to this job only: your Career Profile draft is full.", // C-AF-29
  alreadyInProfile: "Already in your Career Profile.", // C-AF-30
  edit: (fact: string) => `Edit, ${fact}`, // C-AF-31
  addSentence: (term: string) => `Add a sentence about ${term}`, // C-AF-32
  remove: (fact: string) => `Remove, ${fact}`, // C-AF-33
  frozenLine: "Added facts are locked: this Application was submitted or marked complete.", // C-AF-34
  busyLine: "Wait until the documents finish, then change facts.", // C-AF-35
  outreachNote: "Texts you copy to send are written from your Career Profile only.", // C-AF-36
  profileStays: "Removing it here doesn't remove it from your Career Profile.", // C-AF-37
  formTitleAdd: "Add a fact", // C-AF-38
  formTitleSentence: "Add a sentence", // C-AF-38b
  formTitleEdit: "Edit sentence", // C-AF-38c
  textLabel: "What you did", // C-AF-39
  helper: "Say what you did and, if you can, with what and where. For example: Set up GitHub Actions CI/CD at Acme.", // C-AF-40
  helperFromAlert: (term: string) => `The documents mentioned ${term}. If you have done this, say what you did.`, // C-AF-41
  roleLabel: "Role", // C-AF-42
  noRole: "Add a role to your Career Profile first. Sentences print under a role. Ticking terms still works.", // C-AF-43
  goToProfile: "Go to Career Profile",
  chooseRole: "Choose a role", // C-AF-46
  addFactButton: "Add fact", // C-AF-47.save
  editButton: "Save", // C-AF-47.edit
  cancel: "Cancel", // C-AF-47.cancel
  about: (term: string) => `About ${term}`, // C-AF-49
  errorEmpty: "Write a sentence about what you did.", // C-AF-50
  errorTerm: "That term is not in this job's list. The list is refreshed.", // C-AF-51
  errorCeiling: "You can add up to 40 skills for one job.", // C-AF-52
  errorAspiration: "Write only what you have done.", // C-AF-53
  errorNamed: (term: string) => `Say what you did with ${term}.`, // C-AF-54
  errorOneLinerLimit: "You can add up to 10 sentences for one job.", // C-AF-55
  errorTooLong: (n: number) => `That is ${n} characters. The limit is 300.`, // C-AF-56
  errorChanged: "This job's facts changed elsewhere. The list is refreshed. Check it, then save again.", // C-AF-57
  errorContact: "Leave out emails, phone numbers, links and your address.", // C-AF-59.contact
  errorDuplicate: "That is already added for this job.", // C-AF-59.duplicate
  errorRole: "Choose a role.", // C-AF-59.role
  errorAffirm: "Tick the box to say you have done this.", // C-AF-59.affirm
  errorGone: "That fact is gone. The list is refreshed.", // C-AF-59.gone
  stale: "Your added facts changed after these documents were written. Regenerate to use them.", // C-AF-60
  staleQueue: "It won't be submitted automatically until you generate again.", // C-AF-61
  liftHeading: "Strong match with your added facts", // C-AF-62
  liftList: "What lifted it", // C-AF-63
  liftHelper: "It joins the automatic queue. No new documents are written.", // C-AF-64
  liftAction: "Submit with your added skills", // C-AF-65
  liftedConfirmed: "Confirmed. It joins the automatic queue.", // C-AF-66
  liftStale: "Generate again first, so the documents match.", // C-AF-67
  voided: "Your confirmation was cleared because the facts changed. Generate again, then confirm again.", // C-AF-68
  openedFor: (term: string) => `Add a fact form opened for ${term}.`, // C-AF-69
  factSaved: "Fact saved.", // C-AF-71
  factRemoved: "Fact removed.", // C-AF-72.plain
  matchWithProfile: (n: number, m: number) => `Match with your Career Profile: ${n}/${m}`, // C-AF-80
  matchWithAdded: (n: number, m: number) => `With the facts you added: ${n}/${m}`, // C-AF-81
  matchHeading: "What your added facts cover", // C-AF-83
  alertFact: (term: string) => `Add a fact about ${term}`, // C-AF-44
} as const

const added = (page: Page) => page.locator("#added-facts")
const ats = (page: Page) => page.getByRole("region", { name: /^ATS match/ })

async function openApplication(page: Page, applicationId: string, title = "Senior Frontend Engineer") {
  await page.goto(`/applications/${applicationId}`)
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(title) })).toBeVisible()
}

async function openAddForm(page: Page) {
  await added(page).getByRole("button", { name: COPY.addFact, exact: true }).click()
  await expect(added(page).getByRole("heading", { name: COPY.formTitleAdd })).toBeVisible()
}

async function fillOneLiner(page: Page, text: string, role?: string) {
  await added(page).getByLabel(COPY.textLabel).fill(text)
  if (role !== undefined) await added(page).getByLabel(COPY.roleLabel).selectOption({ label: role })
}

async function affirm(page: Page) {
  await added(page).getByRole("checkbox", { name: COPY.affirmation }).check()
}

// As every other spec here does, leave the shared database as this file found it: the last describe seeds ADA's
// Application, and a leftover sample or blocked row would raise "Needs you" for the board and nav specs that follow.
test.afterAll(async () => {
  await resetAddedSkills()
})

test.describe("added skills: tick gap terms (AC 1.1 to 1.9)", () => {
  test.beforeEach(async ({ context }) => {
    await resetAddedSkills()
    await signIn(context, BOLA.email)
  })
  test.afterAll(async () => {
    await resetAddedSkills()
  })

  test("added-skills-tick:50 @ac-1.1: each gap term is its own tickable item carrying the Affirmation, and the plain comma list is gone", async ({ page }) => {
    const { applicationId } = await seedAddedSkillsApplication(BOLA.email, { company: "Northwind Labs" })
    await openApplication(page, applicationId)

    const card = ats(page)
    await expect(card.getByText(COPY.notInProfile)).toBeVisible()
    await expect(card.getByText(COPY.tickInstruction, { exact: true })).toBeVisible()
    await expect(card.getByText(COPY.affirmation, { exact: true })).toBeVisible()
    for (const term of ["Figma", "design systems", "CI/CD pipelines", "frontend testing"]) {
      await expect(card.getByRole("checkbox", { name: COPY.tickName(term), exact: true })).toBeVisible()
    }
    // The old read-only line ("Not in your profile: Figma, design systems, …") is replaced.
    await expect(card.getByText("Figma, design systems", { exact: false })).toHaveCount(0)
    await expect(card.getByRole("button", { name: COPY.addSkills(1) })).toHaveCount(0)
  })

  test("added-skills-tick:80 @ac-1.2 @ac-3.1: ticking one term posts one skill-only fact and the row moves to Added for this job", async ({ page }) => {
    const { applicationId } = await seedAddedSkillsApplication(BOLA.email, { company: "Tick Co" })
    await openApplication(page, applicationId)

    const card = ats(page)
    await card.getByRole("checkbox", { name: COPY.tickName("Figma"), exact: true }).check()
    await expect(card.getByText(COPY.affirmation, { exact: true })).toBeVisible()

    const posted = page.waitForResponse((r) => r.url().endsWith(`/v1/applications/${applicationId}/added-facts`) && r.request().method() === "POST")
    await card.getByRole("button", { name: COPY.addSkills(1), exact: true }).click()
    const response = await posted
    expect(response.status()).toBe(200)
    expect(response.request().postDataJSON()).toEqual({ expectedVersion: 0, items: [{ kind: "skill_only", term: "Figma", affirmed: true, saveToProfile: false }] })

    await expect(added(page).getByText("Figma", { exact: true })).toBeVisible()
    await expect(added(page).getByText(COPY.skillOnly, { exact: true })).toBeVisible()
    await expect(added(page).getByText(COPY.notUsed, { exact: true })).toBeVisible()
    // C-AF-19 counts sentences (one-liners) only, never skill-only facts (copy-deck.md C-AF-19), so a tick leaves it at 0.
    await expect(added(page).getByText("0 of 10 sentences", { exact: true })).toBeVisible()
    await expect(card.getByRole("checkbox", { name: COPY.tickName("Figma"), exact: true })).toHaveCount(0)
    expect(await addedFactsOf(applicationId)).toMatchObject([{ kind: "skill_only", text: "Figma", term: "Figma" }])
  })

  test("added-skills-tick:87 @ac-1.2: several terms ticked in one action become one fact each, with the per-row profile checkbox", async ({ page }) => {
    const { applicationId } = await seedAddedSkillsApplication(BOLA.email, { company: "Multi Co" })
    await openApplication(page, applicationId)

    const card = ats(page)
    await card.getByRole("checkbox", { name: COPY.tickName("Figma"), exact: true }).check()
    await expect(
      card.getByRole("checkbox", { name: COPY.addToProfile, exact: true, description: COPY.profileChoiceDescription("Figma") })
    ).not.toBeChecked()
    await card.getByRole("checkbox", { name: COPY.tickName("design systems"), exact: true }).check()

    const posted = page.waitForResponse((r) => r.url().endsWith("/added-facts") && r.request().method() === "POST")
    await card.getByRole("button", { name: COPY.addSkills(2), exact: true }).click()
    expect((await posted).request().postDataJSON()).toMatchObject({
      expectedVersion: 0,
      items: [
        { kind: "skill_only", term: "Figma", affirmed: true },
        { kind: "skill_only", term: "design systems", affirmed: true },
      ],
    })
    expect(await addedFactsOf(applicationId)).toHaveLength(2)
    await expect(added(page).getByText(COPY.skillOnly, { exact: true })).toHaveCount(2)
  })

  test("added-skills-tick:105 @ac-1.2 @ac-1.8: a forged tick of a term not in the gap list is refused with C-AF-51 and stores nothing", async ({ page }) => {
    const { applicationId } = await seedAddedSkillsApplication(BOLA.email, { company: "Forged Tick Co" })
    await openApplication(page, applicationId)
    const result = await forged(page, "POST", `/v1/applications/${applicationId}/added-facts`, { expectedVersion: 0, items: [{ kind: "skill_only", term: "Kubernetes", affirmed: true }] })
    expect(result.status).toBe(422)
    expect(result.body).toEqual({ error: { code: "added_facts_invalid", message: "Check the highlighted fields. Nothing was saved.", fieldErrors: [{ source: "added_facts", field: "term", position: 1, problem: "term_not_a_gap" }] } })
    // The forged POST bypasses the page, so no UI save happens and no inline error can show; C-AF-51 is the page's own reply to
    // a refused tick (covered by the stale-gap case below). Here the api refusal and the empty store are the proof.
    expect(await addedFactsOf(applicationId)).toEqual([])
  })

  test("added-skills-tick:243 @ac-1.6 @ac-4.1: un-ticking takes one tap, no dialog, and the term returns to the list", async ({ page }) => {
    const { applicationId } = await seedAddedSkillsApplication(BOLA.email, { company: "Untick Co", facts: [{ kind: "skill_only", text: "Figma" }] })
    await openApplication(page, applicationId)

    const row = added(page)
    await expect(row.getByText("Figma", { exact: true })).toBeVisible()
    const removed = page.waitForResponse((r) => r.url().includes("/added-facts/") && r.request().method() === "DELETE")
    await row.getByRole("button", { name: COPY.remove("Figma"), exact: true }).click()
    expect((await removed).status()).toBe(200)
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(row.getByText(COPY.factRemoved, { exact: false })).toBeAttached()
    await expect(ats(page).getByRole("checkbox", { name: COPY.tickName("Figma"), exact: true })).toBeVisible()
    expect(await addedFactsOf(applicationId)).toEqual([])
  })

  test("added-skills-tick:177 @ac-1.4: Add a sentence upgrades the ticked fact in place, keeping one fact", async ({ page }) => {
    const seeded = await seedAddedSkillsApplication(BOLA.email, { company: "Upgrade Co", facts: [{ kind: "skill_only", text: "CI/CD pipelines" }] })
    await openApplication(page, seeded.applicationId)
    const role = seeded.roles[1] ?? seeded.roles[0]!
    const roleLabel = `${role.title} at ${role.employer}`

    await added(page).getByRole("button", { name: COPY.addSentence("CI/CD pipelines"), exact: true }).click()
    await expect(added(page).getByRole("heading", { name: COPY.formTitleSentence })).toBeVisible()
    await expect(added(page).getByText(COPY.about("CI/CD pipelines"), { exact: true })).toBeVisible()
    await fillOneLiner(page, "Set up GitHub Actions CI/CD pipelines at Acme", roleLabel)

    const patched = page.waitForResponse((r) => r.url().includes("/added-facts/") && r.request().method() === "PATCH")
    await added(page).getByRole("button", { name: COPY.addFactButton, exact: true }).click()
    const response = await patched
    expect(response.status()).toBe(200)
    expect(response.request().postDataJSON()).toEqual({ expectedVersion: 1, text: "Set up GitHub Actions CI/CD pipelines at Acme", roleSectionId: role.sectionId })

    await expect(added(page).getByText("Set up GitHub Actions CI/CD pipelines at Acme", { exact: true })).toBeVisible()
    await expect(added(page).getByText(COPY.skillOnly, { exact: true })).toHaveCount(0)
    await expect(added(page).getByText(COPY.sentence, { exact: true })).toBeVisible()
    expect(await addedFactsOf(seeded.applicationId)).toMatchObject([{ kind: "one_liner", term: "CI/CD pipelines" }])
  })

  test("added-skills-tick:298 @ac-1.7 @ac-1.8: the eleventh sentence is refused with C-AF-55 and the form keeps the text", async ({ page }) => {
    const facts = LIFTING_FACTS.map((fact) => ({ ...fact })).slice(0, 4)
    const seeded = await seedAddedSkillsApplication(BOLA.email, {
      company: "Ten Co",
      facts: [...facts, ...Array.from({ length: 6 }, (_, i) => ({ kind: "one_liner" as const, text: `Mentored intern number ${i} at Acme`, roleIndex: 1 }))],
    })
    await openApplication(page, seeded.applicationId)
    const role = `${seeded.roles[1]!.title} at ${seeded.roles[1]!.employer}`

    await openAddForm(page)
    await fillOneLiner(page, "Built a Storybook library at Acme", role)
    await affirm(page)
    await added(page).getByRole("button", { name: COPY.addFactButton, exact: true }).click()
    await expect(added(page).getByText(COPY.errorOneLinerLimit, { exact: true })).toBeVisible()
    await expect(added(page).getByLabel(COPY.textLabel)).toHaveValue("Built a Storybook library at Acme")
    expect(await addedFactsOf(seeded.applicationId)).toHaveLength(10)
  })

  test("added-skills-tick:330 @ac-1.7: the forty-first skill-only fact is refused with C-AF-52", async ({ page }) => {
    const terms = Array.from({ length: 41 }, (_, i) => `term ${i}`)
    const seeded = await seedAddedSkillsApplication(BOLA.email, {
      company: "Ceiling Co",
      gaps: terms,
      facts: terms.slice(0, 40).map((term) => ({ kind: "skill_only" as const, text: term })),
    })
    await openApplication(page, seeded.applicationId)
    await expect(ats(page).getByText(COPY.allAdded, { exact: false })).toHaveCount(0)
    // The 41st term is still tickable, and the API refuses the save.
    await ats(page).getByRole("checkbox", { name: COPY.tickName("term 40"), exact: true }).check()
    await ats(page).getByRole("button", { name: COPY.addSkills(1), exact: true }).click()
    await expect(page.getByText(COPY.errorCeiling, { exact: true })).toBeVisible()
    expect(await addedFactsOf(seeded.applicationId)).toHaveLength(40)
  })

  test("added-skills-tick:69 @ac-1.1 @ac-4.2: a Frozen Application shows gap terms read-only, with no tick control", async ({ page }) => {
    const { applicationId } = await seedAddedSkillsApplication(BOLA.email, { company: "Locked Co", submissionState: "confirmed" })
    await openApplication(page, applicationId)
    await expect(ats(page).getByText("Figma", { exact: true })).toBeVisible()
    await expect(ats(page).getByRole("checkbox")).toHaveCount(0)
    await expect(ats(page).getByText(COPY.tickReadOnly, { exact: true })).toBeVisible()
  })

  test("added-skills-tick:211 @ac-1.5 (OD-14): with no documents there is no gap list and Add a fact still works", async ({ page }) => {
    const { applicationId } = await seedAddedSkillsApplication(BOLA.email, { company: "No Docs Co", state: "prepared", documents: false })
    await openApplication(page, applicationId)
    await expect(ats(page).getByText(COPY.notInProfile)).toHaveCount(0)
    // No ATS card exists without documents; C-AF-21 sits in the Added section (design-spec.r1.md, state table "No ATS result yet").
    await expect(added(page).getByText(/Terms from the posting appear after Eve writes the documents/)).toBeVisible()
    await expect(added(page).getByRole("button", { name: COPY.addFact, exact: true })).toBeVisible()
  })

  test("added-skills-tick:367 @ac-1.8: the tick controls are reachable on mobile without horizontal scrolling", async ({ page }) => {
    const { applicationId } = await seedAddedSkillsApplication(BOLA.email, { company: "Mobile Co" })
    await page.setViewportSize({ width: 375, height: 812 })
    await openApplication(page, applicationId)
    const checkbox = ats(page).getByRole("checkbox", { name: COPY.tickName("Figma"), exact: true })
    await expect(checkbox).toBeVisible()
    const box = await checkbox.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x + box!.width).toBeLessThanOrEqual(375)
    await checkbox.check()
    await expect(
      ats(page).getByRole("checkbox", { name: COPY.addToProfile, exact: true, description: COPY.profileChoiceDescription("Figma") })
    ).toBeVisible()
  })
})

test.describe("added skills: one-liners and the form (AC 2.1, 2.3, 2.5, 2.6, 3.1 to 3.3)", () => {
  test.beforeEach(async ({ context }) => {
    await resetAddedSkills()
    await signIn(context, BOLA.email)
  })

  test("added-skills-one-liners:24 @ac-2.1: Add a fact stores a sentence under the chosen role", async ({ page }) => {
    const seeded = await seedAddedSkillsApplication(BOLA.email, { company: "Sentence Co" })
    await openApplication(page, seeded.applicationId)
    const role = seeded.roles[1]!
    await openAddForm(page)
    await expect(added(page).getByText(COPY.helper, { exact: true })).toBeVisible()
    await expect(added(page).getByLabel(COPY.textLabel)).toHaveValue("")
    await fillOneLiner(page, "Mentored 3 interns on code review at Acme", `${role.title} at ${role.employer}`)
    await affirm(page)

    const posted = page.waitForResponse((r) => r.url().endsWith("/added-facts") && r.request().method() === "POST")
    await added(page).getByRole("button", { name: COPY.addFactButton, exact: true }).click()
    expect((await posted).request().postDataJSON()).toEqual({
      expectedVersion: 0,
      items: [{ kind: "one_liner", text: "Mentored 3 interns on code review at Acme", roleSectionId: role.sectionId, affirmed: true, saveToProfile: false }],
    })
    await expect(added(page).getByText("Mentored 3 interns on code review at Acme", { exact: true })).toBeVisible()
    await expect(added(page).getByText(COPY.sentence, { exact: true })).toBeVisible()
    await expect(added(page).getByText(COPY.factSaved, { exact: true })).toBeAttached()
    await expect(added(page).getByText("1 of 10 sentences", { exact: true })).toBeVisible()
  })

  test("added-skills-one-liners:38 @ac-2.1: a sentence saved without a role shows C-AF-59.role", async ({ page }) => {
    const seeded = await seedAddedSkillsApplication(BOLA.email, { company: "No Role Co" })
    await openApplication(page, seeded.applicationId)
    await openAddForm(page)
    await expect(added(page).getByLabel(COPY.roleLabel)).toHaveValue("")
    await fillOneLiner(page, "Mentored 3 interns on code review at Acme")
    await affirm(page)
    await added(page).getByRole("button", { name: COPY.addFactButton, exact: true }).click()
    await expect(added(page).getByText(COPY.errorRole, { exact: true })).toBeVisible()
    expect(await addedFactsOf(seeded.applicationId)).toEqual([])
  })

  test("added-skills-one-liners:56 @ac-2.1: the counter reads n of 300 and a 301-character paste is refused with C-AF-56, kept for correction", async ({ page }) => {
    const seeded = await seedAddedSkillsApplication(BOLA.email, { company: "Long Co" })
    await openApplication(page, seeded.applicationId)
    const role = `${seeded.roles[1]!.title} at ${seeded.roles[1]!.employer}`
    await openAddForm(page)
    await fillOneLiner(page, "x".repeat(300), role)
    await expect(added(page).getByText("300 of 300", { exact: true })).toBeVisible()
    await fillOneLiner(page, `x${"y".repeat(300)}`, role)
    await affirm(page)
    await added(page).getByRole("button", { name: COPY.addFactButton, exact: true }).click()
    await expect(added(page).getByText(COPY.errorTooLong(301), { exact: true })).toBeVisible()
    await expect(added(page).getByLabel(COPY.textLabel)).toHaveValue(`x${"y".repeat(300)}`)
    expect(await addedFactsOf(seeded.applicationId)).toEqual([])
  })

  test("added-skills-one-liners:95 @ac-2.3 (OD-13): a sentence that does not name its term shows C-AF-54 and stores nothing", async ({ page }) => {
    const seeded = await seedAddedSkillsApplication(BOLA.email, { company: "Named Co", facts: [{ kind: "skill_only", text: "CI/CD pipelines" }] })
    await openApplication(page, seeded.applicationId)
    await added(page).getByRole("button", { name: COPY.addSentence("CI/CD pipelines"), exact: true }).click()
    await fillOneLiner(page, "Set up the release workflow at Acme", `${seeded.roles[1]!.title} at ${seeded.roles[1]!.employer}`)
    await added(page).getByRole("button", { name: COPY.addFactButton, exact: true }).click()
    await expect(added(page).getByText(COPY.errorNamed("CI/CD pipelines"), { exact: true })).toBeVisible()
    expect(await addedFactsOf(seeded.applicationId)).toMatchObject([{ kind: "skill_only" }])
  })

  test("added-skills-one-liners:144 @ac-2.5: a contact detail is refused with C-AF-59.contact and keeps the typed text", async ({ page }) => {
    const seeded = await seedAddedSkillsApplication(BOLA.email, { company: "Contact Co" })
    await openApplication(page, seeded.applicationId)
    await openAddForm(page)
    await fillOneLiner(page, "Set up CI/CD at Acme, write to ada@example.com", `${seeded.roles[1]!.title} at ${seeded.roles[1]!.employer}`)
    await affirm(page)
    await added(page).getByRole("button", { name: COPY.addFactButton, exact: true }).click()
    await expect(added(page).getByText(COPY.errorContact, { exact: true })).toBeVisible()
    await expect(added(page).getByLabel(COPY.textLabel)).toHaveValue("Set up CI/CD at Acme, write to ada@example.com")
  })

  test("added-skills-one-liners:276 @ac-3.3: aspiration text is refused with C-AF-53", async ({ page }) => {
    const seeded = await seedAddedSkillsApplication(BOLA.email, { company: "Learn Co" })
    await openApplication(page, seeded.applicationId)
    await openAddForm(page)
    await fillOneLiner(page, "I want to learn Storybook for the Acme design system", `${seeded.roles[1]!.title} at ${seeded.roles[1]!.employer}`)
    await affirm(page)
    await added(page).getByRole("button", { name: COPY.addFactButton, exact: true }).click()
    await expect(added(page).getByText(COPY.errorAspiration, { exact: true })).toBeVisible()
    expect(await addedFactsOf(seeded.applicationId)).toEqual([])
  })

  test("added-skills-one-liners:230 @ac-3.1: the Affirmation is unticked by default and a save without it shows C-AF-59.affirm", async ({ page }) => {
    const seeded = await seedAddedSkillsApplication(BOLA.email, { company: "Affirm Co" })
    await openApplication(page, seeded.applicationId)
    await openAddForm(page)
    await expect(added(page).getByRole("checkbox", { name: COPY.affirmation })).not.toBeChecked()
    await fillOneLiner(page, "Mentored 3 interns on code review at Acme", `${seeded.roles[1]!.title} at ${seeded.roles[1]!.employer}`)
    await added(page).getByRole("button", { name: COPY.addFactButton, exact: true }).click()
    await expect(added(page).getByText(COPY.errorAffirm, { exact: true })).toBeVisible()
    expect(await addedFactsOf(seeded.applicationId)).toEqual([])
  })

  test("added-skills-one-liners:259 @ac-3.2 @ac-4.1: editing a sentence shows its Affirmation as already given", async ({ page }) => {
    const seeded = await seedAddedSkillsApplication(BOLA.email, { company: "Edit Co", facts: [{ kind: "one_liner", text: "Set up GitHub Actions CI/CD at Acme", roleIndex: 1 }] })
    await openApplication(page, seeded.applicationId)
    await added(page).getByRole("button", { name: COPY.edit("Set up GitHub Actions CI/CD at Acme"), exact: true }).click()
    await expect(added(page).getByRole("heading", { name: COPY.formTitleEdit })).toBeVisible()
    await expect(added(page).getByRole("checkbox")).toHaveCount(0)
    await expect(added(page).getByText(COPY.affirmation, { exact: true })).toBeVisible()
    await fillOneLiner(page, "Set up GitHub Actions CI/CD pipelines at Acme", `${seeded.roles[1]!.title} at ${seeded.roles[1]!.employer}`)
    await added(page).getByRole("button", { name: COPY.editButton, exact: true }).click()
    await expect(added(page).getByText("Set up GitHub Actions CI/CD pipelines at Acme", { exact: true })).toBeVisible()
  })

  test("added-skills-entry-points:95 @ac-2.4: with no experience role the form says so, links to the profile, and ticks stay available", async ({ page }) => {
    await setNoExperienceProfile(BOLA.email)
    const seeded = await seedAddedSkillsApplication(BOLA.email, { company: "No Experience Co" })
    // seedAddedSkillsApplication re-ensures the profile; set it back afterwards.
    await setNoExperienceProfile(BOLA.email)
    await openApplication(page, seeded.applicationId)
    await added(page).getByRole("button", { name: COPY.addFact, exact: true }).click()
    await expect(added(page).getByText(COPY.noRole, { exact: true })).toBeVisible()
    await expect(added(page).getByRole("link", { name: COPY.goToProfile })).toHaveAttribute("href", "/profile")
    await expect(added(page).getByLabel(COPY.textLabel)).toHaveCount(0)
    await expect(ats(page).getByRole("checkbox", { name: COPY.tickName("Figma"), exact: true })).toBeVisible()
  })
})

test.describe("added skills: entry points, lifecycle and states (AC 2.2, 2.7, 4.1 to 4.6, 5.6, 8.2)", () => {
  test.beforeEach(async ({ context }) => {
    await resetAddedSkills()
    await signIn(context, BOLA.email)
  })

  test("added-skills-entry-points:136 @ac-2.7: the blocked alert offers Add a fact about {term}, opens the form empty with C-AF-41, and never inserts the term", async ({ page }) => {
    const seeded = await seedAddedSkillsApplication(BOLA.email, {
      company: "Blocked Co",
      state: "documents_blocked",
      blockedDocument: "cover_letter",
      blockedCause: "unsupported_terms",
      blockedClaim: "I built the Storybook library at Acme.",
      blockedTerms: ["Storybook"],
    })
    await openApplication(page, seeded.applicationId)
    const alert = page.getByRole("alert").filter({ hasText: /blocked/i })
    const action = alert.getByRole("button", { name: COPY.alertFact("Storybook"), exact: true })
    await expect(action).toBeVisible()
    await action.click()
    await expect(added(page).getByText(COPY.helperFromAlert("Storybook"), { exact: true })).toBeVisible()
    await expect(added(page).getByLabel(COPY.textLabel)).toHaveValue("")
    await expect(added(page).getByText(COPY.openedFor("Storybook"), { exact: true })).toBeAttached()
  })

  test("added-skills-entry-points:170 @ac-2.7: the alert offers no action for a failure kind that adding a fact cannot fix", async ({ page }) => {
    const seeded = await seedAddedSkillsApplication(BOLA.email, {
      company: "Contact Block Co",
      state: "documents_blocked",
      blockedDocument: "cover_letter",
      blockedCause: "contact_detail",
      blockedClaim: "You can reach me at sam@example.com.",
    })
    await openApplication(page, seeded.applicationId)
    await expect(page.getByRole("button", { name: /^Add a fact about/ })).toHaveCount(0)
  })

  test("added-skills-lifecycle:137 @ac-4.2: a Frozen Application shows the facts read-only, with C-AF-34 and no controls", async ({ page }) => {
    const seeded = await seedAddedSkillsApplication(BOLA.email, {
      company: "Read Only Co",
      submissionState: "confirmed",
      facts: [
        { kind: "skill_only", text: "Figma" },
        { kind: "one_liner", text: "Set up GitHub Actions CI/CD at Acme", roleIndex: 1 },
      ],
    })
    await openApplication(page, seeded.applicationId)
    const section = added(page)
    await expect(section.getByText(COPY.frozenLine, { exact: true })).toBeVisible()
    await expect(section.getByText("Figma", { exact: true })).toBeVisible()
    await expect(section.getByRole("button", { name: COPY.addFact, exact: true })).toHaveCount(0)
    await expect(section.getByRole("button", { name: /^Remove,/ })).toHaveCount(0)
    await expect(section.getByRole("button", { name: /^Edit,/ })).toHaveCount(0)
    await expect(section.getByRole("button", { name: /^Add a sentence about/ })).toHaveCount(0)
  })

  test("added-skills-lifecycle:211 @ac-4.4: while generating, the page says to wait and offers no change controls", async ({ page }) => {
    const { applicationId } = await seedAddedSkillsApplication(BOLA.email, { company: "Busy Co", state: "generating", submissionState: "submit_claimed" })
    await openApplication(page, applicationId)
    await expect(page.getByText(COPY.busyLine, { exact: true })).toBeVisible()
    await expect(added(page).getByRole("button", { name: COPY.addFact, exact: true })).toHaveCount(0)
  })

  test("added-skills-lifecycle:264 @ac-4.5: a conflicting change shows C-AF-57 and reloads the list", async ({ page }) => {
    const seeded = await seedAddedSkillsApplication(BOLA.email, { company: "Conflict Co", facts: [{ kind: "skill_only", text: "Figma" }] })
    await openApplication(page, seeded.applicationId)
    // The other tab removes it first; this page still thinks version 0.
    const first = await forged(page, "DELETE", `/v1/applications/${seeded.applicationId}/added-facts/${(await addedFactsOf(seeded.applicationId))[0]!.id}?expectedVersion=1`)
    expect(first.status).toBe(200)
    await added(page).getByRole("button", { name: COPY.remove("Figma"), exact: true }).click()
    await expect(added(page).getByText(COPY.errorChanged, { exact: true })).toBeVisible()
    await expect(added(page).getByText("Figma", { exact: true })).toHaveCount(0)
  })

  test("added-skills-documents-truth-guard:431 @ac-5.6: any change after generation shows the stale notice C-AF-60", async ({ page }) => {
    const seeded = await seedAddedSkillsApplication(BOLA.email, { company: "Stale Co", facts: [{ kind: "skill_only", text: "Figma" }], storedVersion: 0 })
    await openApplication(page, seeded.applicationId)
    await expect(page.getByText(COPY.stale, { exact: true })).toBeVisible()
    await expect(ats(page).getByText(/This score is from before your added facts/)).toBeVisible()
  })

  test("added-skills-documents-truth-guard:447 @ac-5.6: documents generated with no added facts become stale when the first fact is added", async ({ page }) => {
    const { applicationId } = await seedAddedSkillsApplication(BOLA.email, { company: "Fresh Then Stale Co" })
    await openApplication(page, applicationId)
    await expect(page.getByText(COPY.stale, { exact: true })).toHaveCount(0)
    await ats(page).getByRole("checkbox", { name: COPY.tickName("Figma"), exact: true }).check()
    await ats(page).getByRole("button", { name: COPY.addSkills(1), exact: true }).click()
    await expect(page.getByText(COPY.stale, { exact: true })).toBeVisible()
  })

  test("added-skills-lifecycle:343 @ac-8.2: the Outreach note shows beside the Added facts block when it has facts", async ({ page }) => {
    const { applicationId } = await seedAddedSkillsApplication(BOLA.email, { company: "Outreach Co", facts: [{ kind: "skill_only", text: "Figma" }] })
    await openApplication(page, applicationId)
    await expect(added(page).getByText(COPY.outreachNote, { exact: true })).toBeVisible()
  })

  test("added-skills-career-profile-save:237 @ac-6.6: the Career Profile note is not shown beside Remove unless the checkbox was ticked", async ({ page }) => {
    const { applicationId } = await seedAddedSkillsApplication(BOLA.email, { company: "No Profile Co", facts: [{ kind: "skill_only", text: "Figma" }] })
    await openApplication(page, applicationId)
    await expect(added(page).getByText(COPY.profileStays, { exact: true })).toHaveCount(0)
  })

  test("added-skills-career-profile-save:29 @ac-6.1: the profile checkbox is shown unticked on a tick row and in the form", async ({ page }) => {
    const seeded = await seedAddedSkillsApplication(BOLA.email, { company: "Checkbox Co" })
    await openApplication(page, seeded.applicationId)
    await ats(page).getByRole("checkbox", { name: COPY.tickName("Figma"), exact: true }).check()
    await expect(
      ats(page).getByRole("checkbox", { name: COPY.addToProfile, exact: true, description: COPY.profileChoiceDescription("Figma") })
    ).not.toBeChecked()
    await openAddForm(page)
    await expect(added(page).getByRole("checkbox", { name: COPY.addToProfile, exact: true })).not.toBeChecked()
  })

  test("added-skills-tick:140 @ac-1.3: saving a tick leaves the ATS score of the existing documents marked stale until regenerated", async ({ page }) => {
    const { applicationId } = await seedAddedSkillsApplication(BOLA.email, { company: "Ats Co" })
    await openApplication(page, applicationId)
    await ats(page).getByRole("checkbox", { name: COPY.tickName("Figma"), exact: true }).check()
    await ats(page).getByRole("button", { name: COPY.addSkills(1), exact: true }).click()
    await expect(ats(page).getByText(/This score is from before your added facts/)).toBeVisible()
    await expect(page.getByText(COPY.stale, { exact: true })).toBeVisible()
  })
})

test.describe("added skills: Match, the lift and the one tap (AC 7.1 to 7.9)", () => {
  test.beforeEach(async ({ context }) => {
    await resetAddedSkills()
    await signIn(context, BOLA.email)
  })

  test("added-skills-match-and-queue:179 @ac-7.4: the Match panel shows both numbers, marked skill only where a tick covers", async ({ page }) => {
    const seeded = await seedAddedSkillsApplication(BOLA.email, {
      company: "Match Co",
      gaps: ["CI/CD pipelines"],
      facts: [{ kind: "skill_only", text: "CI/CD pipelines" }],
    })
    await openApplication(page, seeded.applicationId)
    await expect(page.getByText(COPY.matchWithProfile(3, 10), { exact: true }).first()).toBeVisible()
    await expect(page.getByText(COPY.matchWithAdded(4, 10), { exact: true }).first()).toBeVisible()
    await expect(page.getByText(COPY.matchHeading, { exact: true })).toBeVisible()
    await expect(page.getByText(/Own the CI\/CD pipelines/).first()).toBeVisible()
    expect(await page.getByText(COPY.skillOnly, { exact: true }).count()).toBeGreaterThan(0)
  })

  test("added-skills-match-and-queue:233 @ac-7.6 (OD-17): the lift panel names what lifted it and offers the one tap", async ({ page }) => {
    const seeded = await seedAddedSkillsApplication(BOLA.email, {
      company: "Lift Co",
      postingStatus: "skipped",
      skipReason: "weak_core_match",
      facts: LIFTING_FACTS.map((fact) => ({ ...fact })),
    })
    await openApplication(page, seeded.applicationId)
    const panel = page.getByRole("region", { name: COPY.liftHeading })
    await expect(panel).toBeVisible()
    await expect(panel.getByText(COPY.matchWithProfile(3, 10), { exact: true })).toBeVisible()
    await expect(panel.getByText(COPY.matchWithAdded(7, 10), { exact: true })).toBeVisible()
    await expect(panel.getByText(COPY.liftList, { exact: true })).toBeVisible()
    await expect(panel.getByRole("button", { name: COPY.liftAction, exact: true })).toBeEnabled()
    await expect(panel.getByText(COPY.liftHelper, { exact: true })).toBeVisible()
  })

  test("added-skills-match-and-queue:246 @ac-7.6 @ac-7.7: the tap POSTs the confirm route, queues, and shows C-AF-66", async ({ page, context }) => {
    // The tap queues through /added-facts/confirm, which carries ConvertedFeature("submission") like /queue (OD-17), so it
    // serves only the Operator until EPIC-0002 converts "submission" (CONVERTED.submission=false).
    await signIn(context, ADA.email)
    const seeded = await seedAddedSkillsApplication(ADA.email, {
      company: "Tap Co",
      postingStatus: "skipped",
      skipReason: "weak_core_match",
      facts: LIFTING_FACTS.map((fact) => ({ ...fact })),
    })
    await openApplication(page, seeded.applicationId)
    const confirmed = page.waitForResponse((r) => r.url().endsWith("/added-facts/confirm"))
    await page.getByRole("button", { name: COPY.liftAction, exact: true }).click()
    const response = await confirmed
    expect(response.status()).toBe(200)
    expect(response.request().postDataJSON()).toEqual({ expectedVersion: 4 })
    await expect(page.getByText(COPY.liftedConfirmed, { exact: true })).toBeVisible()
    expect(await applicationRow(seeded.applicationId)).toMatchObject({ submission_state: "queued", added_facts_confirmed_version: 4 })
  })

  test("added-skills-match-and-queue:265 @ac-7.6: with stale documents the button is disabled and C-AF-67 explains why", async ({ page }) => {
    const seeded = await seedAddedSkillsApplication(BOLA.email, {
      company: "Tap Stale Co",
      postingStatus: "skipped",
      skipReason: "weak_core_match",
      facts: LIFTING_FACTS.map((fact) => ({ ...fact })),
      storedVersion: 3,
    })
    await openApplication(page, seeded.applicationId)
    const button = page.getByRole("button", { name: COPY.liftAction, exact: true })
    await expect(button).toHaveAttribute("aria-disabled", "true")
    await expect(page.getByText(COPY.liftStale, { exact: true })).toBeVisible()
    await expect(page.getByText(COPY.stale, { exact: true })).toBeVisible()
  })

  test("added-skills-match-and-queue:310 @ac-7.6: a Frozen Application shows no lift action", async ({ page }) => {
    const seeded = await seedAddedSkillsApplication(BOLA.email, {
      company: "Tap Frozen Co",
      postingStatus: "skipped",
      skipReason: "weak_core_match",
      submissionState: "confirmed",
      facts: LIFTING_FACTS.map((fact) => ({ ...fact })),
    })
    await openApplication(page, seeded.applicationId)
    await expect(page.getByRole("button", { name: COPY.liftAction, exact: true })).toHaveCount(0)
  })

  test("added-skills-match-and-queue:292 @ac-7.6: a request that bypasses the page cannot queue without the confirmation", async ({ page, context }) => {
    // The existing /queue and Activation Gate routes serve only the Operator until EPIC-0002 converts "submission" (CONVERTED.submission=false).
    await signIn(context, ADA.email)
    const seeded = await seedAddedSkillsApplication(ADA.email, {
      company: "Bypass Co",
      postingStatus: "skipped",
      skipReason: "weak_core_match",
      facts: LIFTING_FACTS.map((fact) => ({ ...fact })),
    })
    await openApplication(page, seeded.applicationId)
    const result = await forged(page, "POST", `/v1/applications/${seeded.applicationId}/queue`)
    expect(result.status).toBe(409)
    expect(result.body).toMatchObject({ error: { code: "added_facts_confirmation_required" } })
    expect(await applicationRow(seeded.applicationId)).toMatchObject({ submission_state: null })
  })

  test("added-skills-match-and-queue:326 @ac-7.7: a change after the tap voided the confirmation and drops the Application from the queue", async ({ page, context }) => {
    // The tap queues through /added-facts/confirm, which carries ConvertedFeature("submission") like /queue (OD-17), so it
    // serves only the Operator until EPIC-0002 converts "submission" (CONVERTED.submission=false).
    await signIn(context, ADA.email)
    const seeded = await seedAddedSkillsApplication(ADA.email, {
      company: "Voided Co",
      postingStatus: "skipped",
      skipReason: "weak_core_match",
      facts: LIFTING_FACTS.map((fact) => ({ ...fact })),
    })
    await openApplication(page, seeded.applicationId)
    expect((await confirmThroughPage(page, seeded.applicationId, 4)).status).toBe(200)
    await openApplication(page, seeded.applicationId)
    await added(page).getByRole("button", { name: COPY.edit("Reviewed pull requests at Acme"), exact: true }).click()
    await fillOneLiner(page, "Reviewed pull requests at Brightwave", `${seeded.roles[1]!.title} at ${seeded.roles[1]!.employer}`)
    await added(page).getByRole("button", { name: COPY.editButton, exact: true }).click()
    await expect(page.getByText(COPY.voided, { exact: true })).toBeVisible()
    const row = await applicationRow(seeded.applicationId)
    expect(row.submission_state).toBeNull()
    expect(row.drops).toBe(1)
  })
})

test.describe("added skills: the Activation Gate sample marker (OD-16, AC 7.9)", () => {
  test.beforeEach(async ({ context }) => {
    await resetAddedSkills()
    await signIn(context, BOLA.email)
  })

  test("added-skills-match-and-queue:410 @ac-7.9 (OD-16): a sample whose documents cite added facts is marked Added skills used and lists them", async ({ page, context }) => {
    // The existing /queue and Activation Gate routes serve only the Operator until EPIC-0002 converts "submission" (CONVERTED.submission=false).
    await signIn(context, ADA.email)
    const seeded = await seedAddedSkillsApplication(ADA.email, {
      company: "Marked Sample Co",
      sampleState: "awaiting_review",
      facts: [{ kind: "skill_only", text: "Figma" }],
      storedVersion: 1,
    })
    const [fact] = await addedFactsOf(seeded.applicationId)
    await setDocumentsSnapshot(seeded.applicationId, [{ id: fact!.id, kind: "skill_only", text: "Figma", role: null }], [fact!.id])
    await page.goto(`/activation/${seeded.applicationId}`)
    await expect(page.getByText("Added skills used", { exact: true })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Added facts in this sample" })).toBeVisible()
    await expect(page.getByRole("link", { name: "Edit on the Application page" })).toBeVisible()
    await expect(page.getByText("Figma", { exact: true }).first()).toBeVisible()
  })

  test("added-skills-match-and-queue:420 @ac-7.9 (OD-16): a sample with added facts its documents do not cite is not marked", async ({ page, context }) => {
    // The existing /queue and Activation Gate routes serve only the Operator until EPIC-0002 converts "submission" (CONVERTED.submission=false).
    await signIn(context, ADA.email)
    const seeded = await seedAddedSkillsApplication(ADA.email, {
      company: "Unmarked Sample Co",
      sampleState: "awaiting_review",
      facts: [{ kind: "skill_only", text: "Figma" }],
      storedVersion: 1,
    })
    await setDocumentsSnapshot(seeded.applicationId, [], [])
    await page.goto(`/activation/${seeded.applicationId}`)
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
    await expect(page.getByText("Added skills used", { exact: true })).toHaveCount(0)
    await expect(page.getByRole("heading", { name: "Added facts in this sample" })).toHaveCount(0)
  })
})
