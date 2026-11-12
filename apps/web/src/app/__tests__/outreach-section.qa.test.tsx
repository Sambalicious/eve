import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { http, HttpResponse } from "msw"
import { describe, expect, it, vi } from "vitest"

import { controls, costPause, readyApplication, server, TEST_CSRF_TOKEN } from "@/shared/testing"
import { openDocuments } from "./documents-helpers"

/**
 * QA test authoring, step [5e], EPIC-0014 Outreach messages (design-spec.r1.md sections 2, 3, 5, 7
 * and 12; copy-deck.md C-OM-1 to C-OM-53; gherkin/outreach-section, -reader-name,
 * -copy-and-email, -blocked-quote, -write-again, -pause-and-cost and -availability).
 *
 * The whole app renders against the contract fakes, so the section is asserted through roles,
 * accessible names and visible strings, never through a component or a hook. Every string below is
 * copied from copy-deck.md byte for byte (not imported from the product), so a wording change fails
 * here. The Outreach fakes live in this file because `apps/web/src/shared/testing` is not edited by
 * this task.
 */

const ROLE = "Senior Frontend Engineer"
const COMPANY = "Northwind Labs"
const APPLICATION_NAME = `${ROLE} at ${COMPANY}`

/** copy-deck.md, verbatim. `{kind}` is the lower-case kind, `{Kind}` the sentence-case label. */
const C = {
  heading: "Outreach",
  description:
    "Short texts for this Application, written from your approved Career Profile. You copy and send them yourself. Eve sends nothing.",
  referral: {
    label: "Referral request",
    lower: "referral request",
    purpose: "For an employee of the company. It asks if they would refer you, and is easy to decline.",
  },
  introduction: {
    label: "Introduction",
    lower: "introduction",
    purpose: "For a hiring manager or decision maker. It says what you bring and asks for a short conversation.",
  },
  note: {
    label: "Application note",
    lower: "application note",
    purpose: "For a form field, or the body of an email application. It says what you bring.",
  },
  nameLabel: "Their name",
  nameHint: "Optional. Used in the greeting. Eve never fills this in.",
  save: "Save name",
  write: "Write",
  writeAgain: "Write again",
  writingButton: "Writing…",
  writing: (kind: string) => `Writing your ${kind}. This usually takes under a minute.`,
  empty: "Nothing written yet.",
  linkNote: "This text has no links or sign-off. Add your own before sending it.",
  count: (n: number, max: number) => `${n} of ${max} characters`,
  copy: "Copy",
  copied: "Copied",
  openInEmail: "Open in email",
  copiedAnnounce: (kind: string) => `${kind} copied.`,
  writtenAnnounce: (kind: string) => `Your ${kind} is ready to copy.`,
  copyFailed: "Couldn't copy. Select the text and copy it yourself.",
  linkTooLong: "This is too long to open in an email app. Copy it instead.",
  nameUnsaved: "Name not saved. Save it before you copy or email a text.",
  nameRefused: "Use letters, spaces, hyphens, apostrophes and full stops, up to 40 characters.",
  nameSaveFailed: "The name wasn't saved. Try again.",
  stale: (n: number, m: number) => `Written from Career Profile version ${n}. Your approved version is now ${m}. Write again to use it.`,
  blocked: (kind: string) =>
    `The ${kind} wasn't kept: it failed Eve's checks, so nothing was copied or sent. If a claim is true of you, add that fact to your Career Profile. A new run can differ.`,
  blockedQuoteLabel: "The first sentence that failed Eve's checks:",
  earlierKept: (kind: string) => `Your earlier ${kind} is unchanged.`,
  notApproved: (kind: string) => `The ${kind} wasn't written: Anthropic isn't approved, so no career data was sent.`,
  notConfigured: (kind: string) =>
    `The ${kind} wasn't written: the Anthropic API key is missing on the server, so no career data was sent. Add it to the server's environment, then try again.`,
  providerError: (kind: string) => `The ${kind} wasn't written: Anthropic didn't answer. Try again in a few minutes.`,
  timedOut: (kind: string) => `The ${kind} wasn't written: Anthropic took too long. Try again in a few minutes.`,
  invalidOutput: (kind: string) =>
    `The ${kind} wasn't written: Anthropic's reply wasn't in a form Eve could use, so nothing was kept. Write it again.`,
  noProfile: (kind: string) => `The ${kind} wasn't written: you don't have an approved Career Profile yet.`,
  overBudget: (kind: string, max: number) =>
    `The ${kind} wasn't kept: it came out longer than ${max} characters, and Eve doesn't cut sentences short. Write it again.`,
  interrupted: (kind: string) => `The ${kind} wasn't written: the server restarted while it was being written. Nothing was lost.`,
  other: (kind: string) => `The ${kind} wasn't written. Write it again.`,
  pauseGlobal: (kind: string) =>
    `Eve is paused, so the ${kind} wasn't written. Nothing was sent to anyone. Once automation is resumed, write it again.`,
  pauseCost: (kind: string) =>
    `Paid automation is paused for this month's cost ceiling, so the ${kind} wasn't written. Nothing was sent to anyone.`,
  tabsLabel: "Kind of text",
} as const

const BODY_REFERRAL =
  "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd. I mentored 6 junior developers. " +
  "Would you be open to referring me for the Senior Frontend Engineer role at Northwind Labs, with no pressure at all if the answer is no?"

type Kind = "referral_request" | "introduction" | "application_note"
const SLUGS: Record<Kind, string> = { referral_request: "referral-request", introduction: "introduction", application_note: "application-note" }
const SLUG_TO_KIND: Record<string, Kind> = { "referral-request": "referral_request", introduction: "introduction", "application-note": "application_note" }
const LABELS: Record<Kind, string> = { referral_request: C.referral.label, introduction: C.introduction.label, application_note: C.note.label }
const LOWER: Record<Kind, string> = { referral_request: C.referral.lower, introduction: C.introduction.lower, application_note: C.note.lower }

/** api-contract.md 5.2: the item the read returns. */
type Item = {
  kind: Kind
  status: "idle" | "running"
  readerName: string | null
  text: string | null
  profileVersion: number | null
  writtenAt: string | null
  lastFailure: string | null
  firstFailedSentence: string | null
}

/** contract 7.3: every figure in this epic counts code points. */
const codePoints = (text: string) => Array.from(text).length
const notWritten = (kind: Kind): Item => ({ kind, status: "idle", readerName: null, text: null, profileVersion: null, writtenAt: null, lastFailure: null, firstFailedSentence: null })
const ready = (kind: Kind, body = BODY_REFERRAL, overrides: Partial<Item> = {}): Item => ({
  kind,
  status: "idle",
  readerName: "Amara Okafor",
  text: `Hi Amara Okafor,\n\n${body}`,
  profileVersion: 1,
  writtenAt: "2026-11-09T15:02:41.000Z",
  lastFailure: null,
  firstFailedSentence: null,
  ...overrides,
})
const withNotice = (kind: Kind, lastFailure: string, firstFailedSentence: string | null = null, overrides: Partial<Item> = {}): Item => ({
  ...ready(kind, BODY_REFERRAL, overrides),
  lastFailure,
  firstFailedSentence,
})

/**
 * The three routes of api-contract.md v1.31.0 as a stateful fake: GET serves the items, POST answers
 * 202 running and applies `afterWrite[kind]` to the first following GET, PUT saves or clears the name
 * and returns the recomposed item. Every request is recorded so the G4 ordering can be asserted.
 */
function createOutreachFake(options: {
  items: Item[]
  approvedProfileVersion?: number
  afterWrite?: Partial<Record<Kind, Item>>
  refuseName?: boolean
  failName?: boolean
}) {
  const state = { items: options.items.map((item) => ({ ...item })), approvedProfileVersion: options.approvedProfileVersion ?? 1 }
  const pending = new Map<Kind, Item>()
  const requests: { method: string; path: string; body: unknown }[] = []

  const find = (kind: Kind) => {
    const index = state.items.findIndex((item) => item.kind === kind)
    if (index < 0) throw new Error(`no ${kind} item`)
    return index
  }

  const handlers = [
    http.get("/v1/applications/:id/outreach", () => {
      for (const [kind, item] of pending) {
        state.items[find(kind)] = item
        pending.delete(kind)
      }
      return HttpResponse.json({ items: state.items, approvedProfileVersion: state.approvedProfileVersion })
    }),

    http.post("/v1/applications/:id/outreach/:kind/write", async ({ request, params }) => {
      requests.push({ method: "POST", path: new URL(request.url).pathname, body: null })
      if (request.headers.get("x-csrf-token") !== TEST_CSRF_TOKEN) {
        return HttpResponse.json({ error: { code: "csrf_invalid", message: "The request is missing a valid CSRF token." } }, { status: 403 })
      }
      const kind = SLUG_TO_KIND[String(params.kind)]
      if (!kind) return HttpResponse.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 })
      const item = state.items[find(kind)]!
      const running: Item = { ...item, status: "running", lastFailure: null, firstFailedSentence: null }
      state.items[find(kind)] = running
      const outcome = options.afterWrite?.[kind]
      if (outcome) pending.set(kind, { ...outcome })
      return HttpResponse.json(running, { status: 202 })
    }),

    http.put("/v1/applications/:id/outreach/:kind/reader-name", async ({ request, params }) => {
      const body = (await request.json()) as { readerName?: string | null }
      requests.push({ method: "PUT", path: new URL(request.url).pathname, body })
      if (request.headers.get("x-csrf-token") !== TEST_CSRF_TOKEN) {
        return HttpResponse.json({ error: { code: "csrf_invalid", message: "The request is missing a valid CSRF token." } }, { status: 403 })
      }
      if (options.refuseName) {
        return HttpResponse.json({ error: { code: "outreach_reader_name_invalid", message: C.nameRefused } }, { status: 422 })
      }
      if (options.failName) {
        return HttpResponse.json({ error: { code: "internal_error", message: "Something went wrong." } }, { status: 500 })
      }
      const kind = SLUG_TO_KIND[String(params.kind)]
      if (!kind) return HttpResponse.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 })
      const item = state.items[find(kind)]!
      const name = body.readerName === undefined || body.readerName === null || body.readerName.trim() === "" ? null : body.readerName
      const greeting = name !== null ? `Hi ${name},` : kind === "application_note" ? null : "Hello,"
      const bodyText = item.text?.includes("\n\n") ? item.text.slice(item.text.indexOf("\n\n") + 2) : item.text
      const updated: Item = {
        ...item,
        readerName: name,
        text: item.text === null || bodyText === null ? null : greeting === null ? bodyText : `${greeting}\n\n${bodyText}`,
        firstFailedSentence: null,
      }
      state.items[find(kind)] = updated
      return HttpResponse.json(updated)
    }),
  ]

  return { state, requests, handlers }
}

/** copy-deck.md C-OM-44 to C-OM-46, role-and-company form: each kind has its own subject template. */
const SUBJECT: Record<Kind, (role: string, company: string) => string> = {
  referral_request: (role, company) => `Referral request for ${role} at ${company}`,
  introduction: (role, company) => `Interested in ${role} at ${company}`,
  application_note: (role, company) => `Applying for ${role} at ${company}`,
}

/** `mailto:` as api-contract.md 7.5 builds it: no recipient, `encodeURIComponent` on both parts, `%0A` to `%0D%0A`. */
function mailtoOf(kind: Kind, text: string, roleTitle = ROLE, company = COMPANY): string {
  const subject = SUBJECT[kind](roleTitle, company)
  const body = encodeURIComponent(text).replace(/%0A/g, "%0D%0A")
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${body}`
}

/** An Introduction item whose encoded `mailto:` href is exactly `target` characters (contract 7.5). */
function introductionWithEncodedLength(target: number): Item {
  const greeting = "Hello,\n\n"
  const encodedLength = (body: string) => mailtoOf("introduction", `${greeting}${body}`).length
  // A non-ASCII letter encodes to six characters, so a realistic 800-code-point text can pass 2,000.
  let body = "é".repeat(40)
  while (encodedLength(body) + 6 <= target) body += "é"
  while (encodedLength(body) < target) body += "a"
  const text = `${greeting}${body}`
  if (encodedLength(body) !== target) throw new Error(`fixture is ${encodedLength(body)}, wanted ${target}`)
  if (codePoints(text) > 800) throw new Error("fixture is over the Introduction's total budget")
  return { ...ready("introduction", body), readerName: null, text }
}

function openOutreach(options: {
  items: Item[]
  approvedProfileVersion?: number
  afterWrite?: Partial<Record<Kind, Item>>
  refuseName?: boolean
  failName?: boolean
  paused?: "global" | "cost" | null
  slow?: boolean
  loadError?: boolean
}) {
  const fake = createOutreachFake(options)
  const app = readyApplication({ company: COMPANY, roleTitle: ROLE })
  const path = `/applications/${app.id}`
  const controlsHandlers = options.paused ? pausedControls(options.paused) : null

  if (options.loadError) {
    server.use(http.get("/v1/applications/:id/outreach", () => HttpResponse.json({ error: { code: "internal_error", message: "Something went wrong." } }, { status: 500 })))
  } else if (options.slow) {
    server.use(
      http.get("/v1/applications/:id/outreach", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5_000))
        return HttpResponse.json({ items: options.items, approvedProfileVersion: 1 })
      })
    )
  } else {
    server.use(...fake.handlers)
  }
  if (controlsHandlers) server.use(...controlsHandlers)

  const view = openDocuments(path, { applications: [app] })
  return { ...view, app, fake }
}

/** The section reads the shell's automation state for its pause note (design spec G5). */
function pausedControls(paused: "global" | "cost") {
  const value = paused === "global" ? controls({ globalPaused: true, globalPausedAt: "2026-11-10T08:00:00.000Z" }) : controls({ costPause: costPause() })
  return [http.get("/v1/controls", () => HttpResponse.json(value))]
}

/** The section once its read has settled: a skeleton in the content means it is still in flight. */
const REGION = async () => {
  const region = await screen.findByRole("region", { name: C.heading })
  await waitFor(() => expect(region.querySelector('[data-slot="skeleton"]')).toBeNull())
  return region
}

/**
 * The selected kind's panel only. design-spec.r1 keeps every panel mounted, so an
 * unselected panel is `hidden`: a role query skips it, and the guide's own text is
 * asserted per panel rather than across the whole section.
 */
const PANEL = (region: HTMLElement) => within(region).getByRole("tabpanel")

async function selectTab(label: string) {
  const region = await REGION()
  await userEvent.setup({ delay: null }).click(within(region).getByRole("tab", { name: new RegExp(`^${label}`) }))
}

describe("outreach-section.feature: the section and its tablist", () => {
  it("shows one labelled Outreach region with a three-tab tablist in the fixed order and only the Referral request block (AC 1.1, G2)", async () => {
    openOutreach({ items: [notWritten("referral_request"), notWritten("introduction"), notWritten("application_note")] })
    const region = await REGION()
    expect(within(region).getByText(C.description)).toBeVisible()
    const tablist = within(region).getByRole("tablist", { name: C.tabsLabel })
    expect(within(tablist).getAllByRole("tab").map((entry) => entry.textContent)).toEqual([C.referral.label, C.introduction.label, C.note.label])
    expect(within(tablist).getByRole("tab", { name: /^Referral request/ })).toHaveAttribute("aria-selected", "true")
    expect(within(region).getByText(C.referral.purpose)).toBeVisible()
    expect(within(region).getByText(C.introduction.purpose)).not.toBeVisible()
    expect(within(region).getByText(C.note.purpose)).not.toBeVisible()
  })

  it("selecting a tab shows that kind's block with its own purpose line (AC 1.4)", async () => {
    openOutreach({ items: [notWritten("referral_request"), notWritten("introduction"), notWritten("application_note")] })
    await selectTab(C.introduction.label)
    const region = await REGION()
    expect(within(region).getByText(C.introduction.purpose)).toBeVisible()
    expect(within(region).getByText(C.referral.purpose)).not.toBeVisible()
    await selectTab(C.note.label)
    expect(within(region).getByText(C.note.purpose)).toBeVisible()
  })

  it("a block with no text shows the purpose, an empty name field, the empty fill and Write, and no use row (AC 1.4, state Not written)", async () => {
    openOutreach({ items: [notWritten("referral_request"), notWritten("introduction"), notWritten("application_note")] })
    const region = await REGION()
    const panel = PANEL(region)
    expect(within(panel).getByText(C.referral.purpose)).toBeVisible()
    const name = within(panel).getByLabelText(C.nameLabel)
    expect(name).toHaveValue("")
    expect(within(panel).getByText(C.nameHint)).toBeVisible()
    expect(within(panel).getByText(C.empty)).toBeVisible()
    expect(within(panel).getByRole("button", { name: /^Write/ })).toBeEnabled()
    expect(within(panel).queryByRole("button", { name: /^Copy/ })).not.toBeInTheDocument()
    expect(within(panel).queryByRole("link", { name: /^Open in email/ })).not.toBeInTheDocument()
    expect(within(panel).queryByText(/Profile version/)).not.toBeInTheDocument()
    expect(within(panel).queryByText(/characters$/)).not.toBeInTheDocument()
  })

  it("a Ready block shows the plain text, the meta line, the link note and the use row (AC 1.4, AC 1.5)", async () => {
    const body = "I built Q&A tooling and R&D dashboards at Brightwave Ltd."
    openOutreach({ items: [ready("referral_request", body), notWritten("introduction"), notWritten("application_note")] })
    const region = await REGION()
    const text = region.querySelector("textarea") as HTMLTextAreaElement
    expect(text.value).toBe(`Hi Amara Okafor,\n\n${body}`)
    expect(text.readOnly).toBe(true)
    expect(within(region).getByText("Profile version 1")).toBeVisible()
    expect(within(region).getByText(C.count(codePoints(`Hi Amara Okafor,\n\n${body}`), 600))).toBeVisible()
    expect(within(region).getByText(/9 Nov 2026/)).toBeVisible()
    expect(within(region).getByText(C.linkNote)).toBeVisible()
    expect(within(region).getByRole("button", { name: /^Copy/ })).toBeEnabled()
    expect(within(region).getByRole("link", { name: /^Open in email/ })).toBeVisible()
    expect(within(region).getByRole("button", { name: /^Write again/ })).toBeVisible()
    expect(within(region).queryByRole("button", { name: /^Write$/ })).not.toBeInTheDocument()
  })

  it("shows the character count as a plain figure with no warning about a third party's limit (AC 4.1, G9)", async () => {
    const body = "a".repeat(582) // 18 code points of greeting and blank line, so the text is exactly 600
    const text = `Hi Amara Okafor,\n\n${body}`
    expect(codePoints(text)).toBe(600)
    openOutreach({ items: [ready("referral_request", body), notWritten("introduction"), notWritten("application_note")] })
    const region = await REGION()
    expect(within(region).getByText(C.count(codePoints(text), 600))).toBeVisible()
    expect(region.textContent).not.toMatch(/linkedin/i)
    expect(within(region).getByRole("button", { name: /^Copy/ })).toBeEnabled()
  })

  it("keeps the tab order once a text exists (AC 1.1)", async () => {
    openOutreach({ items: [notWritten("referral_request"), notWritten("introduction"), ready("application_note", "A note.")] })
    const region = await REGION()
    expect(within(region).getAllByRole("tab").map((entry) => entry.textContent)).toEqual([C.referral.label, C.introduction.label, C.note.label])
  })

  it("is reachable and operable by keyboard alone: arrows move tabs, Tab reaches the name field and Write (section 12)", async () => {
    const { user } = openOutreach({ items: [notWritten("referral_request"), notWritten("introduction"), notWritten("application_note")] })
    const region = await REGION()
    const first = within(region).getByRole("tab", { name: /^Referral request/ })
    first.focus()
    await user.keyboard("{ArrowRight}")
    expect(within(region).getByRole("tab", { name: /^Introduction/ })).toHaveAttribute("aria-selected", "true")
    await user.keyboard("{Home}")
    expect(within(region).getByRole("tab", { name: /^Referral request/ })).toHaveAttribute("aria-selected", "true")
    await user.tab()
    expect(within(PANEL(region)).getByLabelText(C.nameLabel)).toHaveFocus()
  })
})

describe("outreach-availability.feature: the read states", () => {
  it("shows the heading and a skeleton, with no tabs, while the read is in flight (state Loading)", async () => {
    openOutreach({ items: [notWritten("referral_request"), notWritten("introduction"), notWritten("application_note")], slow: true })
    expect(await screen.findByRole("heading", { level: 2, name: C.heading })).toBeVisible()
    expect(within(screen.getByRole("region", { name: C.heading })).queryByRole("tablist")).not.toBeInTheDocument()
  })

  it("shows the load error with Try again when the first read fails (state Load error)", async () => {
    openOutreach({ items: [notWritten("referral_request"), notWritten("introduction"), notWritten("application_note")], loadError: true })
    expect(await screen.findByRole("heading", { level: 2, name: C.heading })).toBeVisible()
    expect(await screen.findByRole("button", { name: "Try again" })).toBeVisible()
  })

  it("renders no Outreach section and no action when the details are deleted (state Unavailable, AC 1.2)", async () => {
    server.use(
      http.get("/v1/applications/:id/outreach", () => HttpResponse.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 }))
    )
    const app = readyApplication({ company: COMPANY, roleTitle: ROLE })
    openDocuments(`/applications/${app.id}`, { applications: [app] })
    await screen.findByRole("heading", { level: 1, name: APPLICATION_NAME })
    await waitFor(() => expect(screen.queryByRole("region", { name: C.heading })).not.toBeInTheDocument())
    expect(screen.queryByRole("tablist", { name: C.tabsLabel })).not.toBeInTheDocument()
  })
})

describe("outreach-write-again.feature: writing states", () => {
  it("shows the writing line and disables Write while a Run is in flight, with nothing else (state Generating, no earlier text)", async () => {
    openOutreach({
      items: [{ ...notWritten("referral_request"), status: "running" }, notWritten("introduction"), notWritten("application_note")],
    })
    const region = await REGION()
    expect(within(region).getByText(C.writing(LOWER.referral_request))).toBeVisible()
    expect(within(region).getByRole("button", { name: /^Writing/ })).toHaveAttribute("aria-disabled", "true")
    expect(within(region).queryByRole("button", { name: /^Copy/ })).not.toBeInTheDocument()
    expect(within(region).queryByLabelText(/^Text of the referral request/)).not.toBeInTheDocument()
  })

  it("keeps the earlier text visible and copyable while the new Run writes (state Generating, earlier text, AC 7.5)", async () => {
    openOutreach({ items: [{ ...ready("referral_request"), status: "running" }, notWritten("introduction"), notWritten("application_note")] })
    const region = await REGION()
    expect(within(region).getByText(C.writing(LOWER.referral_request))).toBeVisible()
    expect(region.querySelector("textarea")).toHaveValue(`Hi Amara Okafor,\n\n${BODY_REFERRAL}`)
    expect(within(region).getByRole("button", { name: /^Copy/ })).toBeEnabled()
  })

  it("a second request for a kind already writing shows the writing state and no error (state Conflict, AC 7.6)", async () => {
    const items: Item[] = [{ ...notWritten("referral_request"), status: "running" }, notWritten("introduction"), notWritten("application_note")]
    openOutreach({ items })
    const region = await REGION()
    expect(within(region).getByText(C.writing(LOWER.referral_request))).toBeVisible()
    expect(within(region).queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByText(/Something went wrong|wasn't written/)).not.toBeInTheDocument()
  })

  it("Write starts a Run, shows the writing line, then settles on the new text (AC 7.1)", async () => {
    const { user } = openOutreach({
      items: [notWritten("referral_request"), notWritten("introduction"), notWritten("application_note")],
      afterWrite: { referral_request: ready("referral_request") },
    })
    const region = await REGION()
    await user.click(within(region).getByRole("button", { name: /^Write/ }))
    expect(await within(region).findByText(C.writing(LOWER.referral_request))).toBeVisible()
    expect(await within(region).findByText(C.writtenAnnounce(LOWER.referral_request), { exact: false })).toBeInTheDocument()
    await waitFor(() => expect(region.querySelector("textarea")).toHaveValue(`Hi Amara Okafor,\n\n${BODY_REFERRAL}`))
  })

  it("shows the Ready state with no notice when a Run dropped sentences but still wrote a text (AC 2.11)", async () => {
    openOutreach({ items: [ready("referral_request"), notWritten("introduction"), notWritten("application_note")] })
    const region = await REGION()
    expect(within(region).queryByText(C.blocked(LOWER.referral_request))).not.toBeInTheDocument()
    expect(within(region).queryByText(C.blockedQuoteLabel)).not.toBeInTheDocument()
    expect(within(region).queryByRole("alert")).not.toBeInTheDocument()
  })

  it("keeps the previous text beside any non-blocked cause and appends the earlier-kept line (state Ready with notice, AC 7.3)", async () => {
    openOutreach({ items: [withNotice("referral_request", "provider_error"), notWritten("introduction"), notWritten("application_note")] })
    const region = await REGION()
    expect(within(region).getByText(C.providerError(LOWER.referral_request))).toBeVisible()
    expect(within(region).getByText(C.earlierKept(LOWER.referral_request))).toBeVisible()
    expect(region.querySelector("textarea")).toHaveValue(`Hi Amara Okafor,\n\n${BODY_REFERRAL}`)
    expect(within(region).getByRole("button", { name: /^Copy/ })).toBeEnabled()
    expect(within(region).queryByText(C.blockedQuoteLabel)).not.toBeInTheDocument()
  })

  it("shows the cause line alone with no earlier-kept line when no text exists (state Not written with notice, AC 7.3)", async () => {
    openOutreach({
      items: [{ ...notWritten("referral_request"), lastFailure: "timed_out" }, notWritten("introduction"), notWritten("application_note")],
    })
    const region = await REGION()
    expect(within(region).getByText(C.timedOut(LOWER.referral_request))).toBeVisible()
    expect(within(region).queryByText(C.earlierKept(LOWER.referral_request))).not.toBeInTheDocument()
    expect(within(region).queryByRole("button", { name: /^Copy/ })).not.toBeInTheDocument()
  })

  it.each([
    ["invalid_output", C.invalidOutput(LOWER.referral_request)],
    ["interrupted", C.interrupted(LOWER.referral_request)],
    ["not_approved", C.notApproved(LOWER.referral_request)],
    ["not_configured", C.notConfigured(LOWER.referral_request)],
    ["no_career_profile", C.noProfile(LOWER.referral_request)],
    ["gremlins", C.other(LOWER.referral_request)],
  ])("maps the cause %s to its exact notice (AC 11.3)", async (cause, notice) => {
    openOutreach({
      items: [{ ...notWritten("referral_request"), lastFailure: cause }, notWritten("introduction"), notWritten("application_note")],
    })
    const region = await REGION()
    expect(within(region).getByText(notice)).toBeVisible()
    expect(within(region).queryByText(C.blockedQuoteLabel)).not.toBeInTheDocument()
  })

  it("shows over_budget with the kind's total budget and never a sentence (state Over budget, AC 4.4)", async () => {
    openOutreach({
      items: [{ ...notWritten("referral_request"), lastFailure: "over_budget", firstFailedSentence: "A sentence that must not show." }, notWritten("introduction"), notWritten("application_note")],
    })
    const region = await REGION()
    expect(within(region).getByText(C.overBudget(LOWER.referral_request, 600))).toBeVisible()
    expect(within(region).queryByText("A sentence that must not show.")).not.toBeInTheDocument()
  })

  it("links not_approved to /privacy#ai-provider and no_career_profile to /profile (state Anthropic not approved, Profile not approved)", async () => {
    openOutreach({
      items: [{ ...notWritten("referral_request"), lastFailure: "not_approved" }, notWritten("introduction"), notWritten("application_note")],
    })
    const region = await REGION()
    expect(within(region).getByRole("link", { name: "Review and approve" })).toHaveAttribute("href", "/privacy#ai-provider")
    expect(within(region).getByText(C.notApproved(LOWER.referral_request))).toBeVisible()
  })

  it("links no_career_profile to /profile (state Profile not approved, AC 10.2)", async () => {
    openOutreach({
      items: [{ ...notWritten("referral_request"), lastFailure: "no_career_profile" }, notWritten("introduction"), notWritten("application_note")],
    })
    const region = await REGION()
    expect(within(region).getByRole("link", { name: "Go to Career Profile" })).toHaveAttribute("href", "/profile")
    expect(within(region).getByText(C.noProfile(LOWER.referral_request))).toBeVisible()
  })

  it("shows the stale line with both versions and keeps the text copyable (state Stale, AC 7.8)", async () => {
    openOutreach({ items: [ready("referral_request"), notWritten("introduction"), notWritten("application_note")], approvedProfileVersion: 2 })
    const region = await REGION()
    expect(within(region).getByText(C.stale(1, 2))).toBeVisible()
    expect(within(region).getByRole("button", { name: /^Copy/ })).toBeEnabled()
  })
})

describe("outreach-pause-and-cost.feature: pauses", () => {
  it("shows the global pause note, not an alert and no failure, while keeping Copy usable (AC 10.3, G5)", async () => {
    openOutreach({ items: [ready("referral_request"), notWritten("introduction"), notWritten("application_note")], paused: "global" })
    const region = await REGION()
    expect(await within(region).findByText(C.pauseGlobal(LOWER.referral_request))).toBeVisible()
    expect(within(region).queryByRole("button", { name: /Resume/ })).not.toBeInTheDocument()
    expect(within(region).queryByRole("button", { name: /Pause/ })).not.toBeInTheDocument()
    expect(within(region).getByRole("button", { name: /^Copy/ })).toBeEnabled()
  })

  it("shows the cost pause note with the Settings cost link and no global pause line (AC 10.4)", async () => {
    openOutreach({ items: [notWritten("referral_request"), notWritten("introduction"), notWritten("application_note")], paused: "cost" })
    const region = await REGION()
    expect(await within(region).findByText(C.pauseCost(LOWER.referral_request))).toBeVisible()
    expect(within(region).getByRole("link", { name: /Review cost ceiling/ })).toHaveAttribute("href", "/pause-and-cost#cost")
    expect(within(region).queryByText(C.pauseGlobal(LOWER.referral_request))).not.toBeInTheDocument()
  })
})

describe("outreach-blocked-quote.feature: the blocked notice and its quote", () => {
  it("shows the cause line, the label and the quoted sentence, with Write and no Copy when there is no earlier text (AC 7.10, AC 11.4)", async () => {
    openOutreach({
      items: [withNotice("referral_request", "blocked", "I built the merchant dashboard in Angular.", { text: null, profileVersion: null, writtenAt: null, readerName: null }), notWritten("introduction"), notWritten("application_note")],
    })
    const region = await REGION()
    expect(within(region).getByText(C.blocked(LOWER.referral_request))).toBeVisible()
    expect(within(region).getByText(C.blockedQuoteLabel)).toBeVisible()
    const quote = within(region).getByRole("blockquote")
    expect(quote).toHaveTextContent("I built the merchant dashboard in Angular.")
    expect(quote).toHaveAttribute("dir", "auto")
    expect(quote.querySelector("a, button, textarea")).toBeNull()
    expect(within(region).getByRole("button", { name: /^Write/ })).toBeVisible()
    expect(within(region).queryByRole("button", { name: /^Copy/ })).not.toBeInTheDocument()
    expect(within(region).queryByText(C.earlierKept(LOWER.referral_request))).not.toBeInTheDocument()
  })

  it("keeps the earlier text beside the quote and appends the earlier-kept line after it (AC 7.2, AC 7.3)", async () => {
    openOutreach({ items: [withNotice("referral_request", "blocked", "I built the merchant dashboard in Angular."), notWritten("introduction"), notWritten("application_note")] })
    const region = await REGION()
    expect(region.querySelector("textarea")).toHaveValue(`Hi Amara Okafor,\n\n${BODY_REFERRAL}`)
    expect(within(region).getByRole("blockquote")).toHaveTextContent("I built the merchant dashboard in Angular.")
    expect(within(region).getByText(C.earlierKept(LOWER.referral_request))).toBeVisible()
    expect(within(region).getByRole("button", { name: /^Copy/ })).toBeEnabled()
  })

  it("shows the cause line alone when no sentence failed, with no empty label (state Blocked, no sentence)", async () => {
    openOutreach({ items: [withNotice("referral_request", "blocked", null, { text: null, profileVersion: null, writtenAt: null }), notWritten("introduction"), notWritten("application_note")] })
    const region = await REGION()
    expect(within(region).getByText(C.blocked(LOWER.referral_request))).toBeVisible()
    expect(within(region).queryByText(C.blockedQuoteLabel)).not.toBeInTheDocument()
    expect(within(region).queryByRole("blockquote")).not.toBeInTheDocument()
  })

  it("withholds a quote that still holds an unfilled {role_phrase} token, showing the cause line only (CURRENT.md decision 8)", async () => {
    openOutreach({
      items: [
        withNotice("referral_request", "blocked", "I would love to join {role_phrase} and was a Senior Frontend Engineer at Brightwave Ltd.", { text: null, profileVersion: null, writtenAt: null }),
        notWritten("introduction"),
        notWritten("application_note"),
      ],
    })
    const region = await REGION()
    expect(within(region).getByText(C.blocked(LOWER.referral_request))).toBeVisible()
    expect(within(region).queryByText(C.blockedQuoteLabel)).not.toBeInTheDocument()
    expect(within(region).queryByRole("blockquote")).not.toBeInTheDocument()
    expect(within(region).queryByText(/company_phrase/)).not.toBeInTheDocument()
  })

  it("ignores a stored sentence under any cause other than blocked (AC 11.3)", async () => {
    openOutreach({
      items: [{ ...notWritten("referral_request"), lastFailure: "provider_error", firstFailedSentence: "I built the merchant dashboard in Angular." }, notWritten("introduction"), notWritten("application_note")],
    })
    const region = await REGION()
    expect(within(region).getByText(C.providerError(LOWER.referral_request))).toBeVisible()
    expect(within(region).queryByRole("blockquote")).not.toBeInTheDocument()
    expect(within(region).queryByText(/Angular/)).not.toBeInTheDocument()
  })

  it("renders the quote as inert plain text: no link made from a URL, an email or a phone number (AC 11.4)", async () => {
    const sentence = "I built a React dashboard at Brightwave Ltd, write to recruiter@northwind.example or call +1 415 555 0100, see https://apply.northwind.example/ref."
    openOutreach({
      items: [withNotice("referral_request", "blocked", sentence, { text: null, profileVersion: null, writtenAt: null }), notWritten("introduction"), notWritten("application_note")],
    })
    const region = await REGION()
    const quote = within(region).getByRole("blockquote")
    expect(quote).toHaveTextContent(sentence)
    expect(quote.querySelector("a")).toBeNull()
    expect(region.innerHTML).not.toContain("mailto:recruiter")
    expect(region.innerHTML).not.toContain("tel:")
  })

  it("shows the quote's characters verbatim: quotation marks, an ampersand, angle brackets, non-Latin script (AC 11.4)", async () => {
    const sentence = 'I said "ship it" & built <b>Q&A</b> tools in 日本語 at Brightwave Ltd.'
    openOutreach({
      items: [withNotice("referral_request", "blocked", sentence, { text: null, profileVersion: null, writtenAt: null }), notWritten("introduction"), notWritten("application_note")],
    })
    const region = await REGION()
    const quote = within(region).getByRole("blockquote")
    expect(quote.textContent).toContain(sentence)
    expect(quote.querySelector("b")).toBeNull()
  })
})

describe("outreach-copy-and-email.feature: Copy and Open in email", () => {
  it("Copy puts exactly the Ready text on the clipboard and shows the Copied state (AC 6.1, AC 6.2)", async () => {
    const { user } = openOutreach({ items: [ready("referral_request"), notWritten("introduction"), notWritten("application_note")] })
    const region = await REGION()
    const copy = within(region).getByRole("button", { name: /^Copy/ })
    await user.click(copy)
    expect(await navigator.clipboard.readText()).toBe(`Hi Amara Okafor,\n\n${BODY_REFERRAL}`)
    expect(copy).toHaveTextContent(C.copied)
    expect(within(region).getByText(C.copiedAnnounce(C.referral.label))).toBeInTheDocument()
  })

  it("says so and selects the text when the clipboard refuses (state Copy refused, AC 6.2)", async () => {
    const { user } = openOutreach({ items: [ready("referral_request"), notWritten("introduction"), notWritten("application_note")] })
    const region = await REGION()
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new DOMException("denied", "NotAllowedError"))
    await user.click(within(region).getByRole("button", { name: /^Copy/ }))
    expect(await within(region).findByRole("alert")).toHaveTextContent(C.copyFailed)
    expect(within(region).queryByText(C.copied)).not.toBeInTheDocument()
  })

  it("Open in email is a mailto link with no recipient, the Ready text as its body and the filled subject (AC 6.3)", async () => {
    openOutreach({ items: [ready("referral_request"), notWritten("introduction"), notWritten("application_note")] })
    const region = await REGION()
    const href = within(region).getByRole("link", { name: /^Open in email/ }).getAttribute("href") ?? ""
    expect(href.startsWith("mailto:?")).toBe(true)
    expect(href.slice("mailto:?".length).split("&")[0]).toMatch(/^subject=/)
    const text = `Hi Amara Okafor,\n\n${BODY_REFERRAL}`
    const decodedBody = new URL(href).searchParams.get("body") ?? ""
    expect(decodedBody.replace(/\r\n/g, "\n")).toBe(text)
    expect(new URL(href).searchParams.get("subject")).toBe(`Referral request for ${ROLE} at ${COMPANY}`)
    expect(href).toContain("%0D%0A")
    expect(href).not.toMatch(/mailto:[^?]/)
  })

  it.each([
    ["referral_request", "Referral request"],
    ["introduction", "Interested in"],
    ["application_note", "Applying for"],
  ] as const)("each kind has its own subject template for %s (AC 6.3)", async (kind, opening) => {
    openOutreach({ items: [ready("referral_request"), ready("introduction"), ready("application_note", "A note.")] })
    await selectTab(LABELS[kind])
    const region = await REGION()
    const href = within(region).getByRole("link", { name: /^Open in email/ }).getAttribute("href") ?? ""
    const subject = new URL(href).searchParams.get("subject") ?? ""
    expect(subject).toBe(SUBJECT[kind](ROLE, COMPANY))
    expect(subject.startsWith(`${opening} `)).toBe(true)
    expect(codePoints(subject)).toBeLessThanOrEqual(120)
  })

  it("hides Open in email and shows C-OM-36 beside Copy when the encoded link would be over 2,000 characters (state Link too long, AC 6.4)", async () => {
    const veryLong = introductionWithEncodedLength(2_001)
    openOutreach({ items: [notWritten("referral_request"), veryLong, notWritten("application_note")] })
    await selectTab(C.introduction.label)
    const region = await REGION()
    expect(within(region).queryByRole("link", { name: /^Open in email/ })).not.toBeInTheDocument()
    expect(within(region).getByText(C.linkTooLong)).toBeVisible()
    expect(within(region).getByRole("button", { name: /^Copy/ })).toBeEnabled()
  })

  it("offers Open in email at exactly 2,000 encoded characters (AC 6.4 boundary)", async () => {
    const atLimit = introductionWithEncodedLength(2_000)
    openOutreach({ items: [notWritten("referral_request"), atLimit, notWritten("application_note")] })
    await selectTab(C.introduction.label)
    const region = await REGION()
    expect(within(region).getByRole("link", { name: /^Open in email/ })).toBeVisible()
    expect(within(region).queryByText(C.linkTooLong)).not.toBeInTheDocument()
  })

  it("waits for an unsaved name: C-OM-47 shows, Copy and Open in email cannot be used and nothing reaches the clipboard (G3)", async () => {
    const { user } = openOutreach({ items: [ready("referral_request", BODY_REFERRAL, { readerName: "Amara Okafor" }), notWritten("introduction"), notWritten("application_note")] })
    const region = await REGION()
    await user.clear(within(PANEL(region)).getByLabelText(C.nameLabel))
    await user.type(within(PANEL(region)).getByLabelText(C.nameLabel), "Dana Whitfield")
    expect(await within(region).findByText(C.nameUnsaved)).toBeVisible()
    const copy = within(region).getByRole("button", { name: /^Copy/ })
    expect(copy).toHaveAttribute("aria-disabled", "true")
    expect(within(region).getByRole("link", { name: /^Open in email/ })).toHaveAttribute("aria-disabled", "true")
    await navigator.clipboard.writeText("unchanged")
    await user.click(copy)
    expect(await navigator.clipboard.readText()).toBe("unchanged")
  })

  it("saving the name ends the wait and the new greeting reaches the clipboard (AC 5.4, G3)", async () => {
    const { user } = openOutreach({ items: [ready("referral_request"), notWritten("introduction"), notWritten("application_note")] })
    const region = await REGION()
    await user.clear(within(PANEL(region)).getByLabelText(C.nameLabel))
    await user.type(within(PANEL(region)).getByLabelText(C.nameLabel), "Dana Whitfield")
    await user.click(within(region).getByRole("button", { name: /^Save name/ }))
    await waitFor(() => expect(within(region).queryByText(C.nameUnsaved)).not.toBeInTheDocument())
    await user.click(within(region).getByRole("button", { name: /^Copy/ }))
    expect(await navigator.clipboard.readText()).toBe(`Hi Dana Whitfield,\n\n${BODY_REFERRAL}`)
  })

  it("types the saved name back and the wait ends with no save request (G3)", async () => {
    const { user } = openOutreach({ items: [ready("referral_request"), notWritten("introduction"), notWritten("application_note")] })
    const region = await REGION()
    const field = within(PANEL(region)).getByLabelText(C.nameLabel)
    await user.clear(field)
    await user.type(field, "Dana Whitfield")
    expect(await within(region).findByText(C.nameUnsaved)).toBeVisible()
    await user.clear(field)
    await user.type(field, "Amara Okafor")
    await waitFor(() => expect(within(region).queryByText(C.nameUnsaved)).not.toBeInTheDocument())
    await user.click(within(region).getByRole("button", { name: /^Copy/ }))
    expect(await navigator.clipboard.readText()).toBe(`Hi Amara Okafor,\n\n${BODY_REFERRAL}`)
  })

  it("never copies or mails the blocked quote (AC 1.5, AC 11.4)", async () => {
    const { user } = openOutreach({ items: [withNotice("referral_request", "blocked", "I built the merchant dashboard in Angular."), notWritten("introduction"), notWritten("application_note")] })
    const region = await REGION()
    await user.click(within(region).getByRole("button", { name: /^Copy/ }))
    expect(await navigator.clipboard.readText()).toBe(`Hi Amara Okafor,\n\n${BODY_REFERRAL}`)
    const href = within(region).getByRole("link", { name: /^Open in email/ }).getAttribute("href") ?? ""
    expect(href).not.toContain("Angular")
    expect(new URL(href).searchParams.get("subject")).not.toContain("Angular")
  })
})

describe("outreach-reader-name.feature: saving the name", () => {
  it("refuses a name with a digit beside the field, as an alert, and keeps the saved name (state Name refused, AC 5.2)", async () => {
    const { user } = openOutreach({ items: [ready("referral_request"), notWritten("introduction"), notWritten("application_note")] })
    const region = await REGION()
    const field = within(PANEL(region)).getByLabelText(C.nameLabel)
    await user.clear(field)
    await user.type(field, "Amara2")
    await user.click(within(region).getByRole("button", { name: /^Save name/ }))
    const alert = await within(region).findByRole("alert")
    expect(alert).toHaveTextContent(C.nameRefused)
    expect(field).toHaveAttribute("aria-invalid", "true")
    expect(screen.queryByRole("status", { name: C.nameRefused })).not.toBeInTheDocument()
  })

  it("shows C-OM-48 under the field when the save request fails (state Name save failed)", async () => {
    const { user } = openOutreach({ items: [ready("referral_request"), notWritten("introduction"), notWritten("application_note")], failName: true })
    const region = await REGION()
    const field = within(PANEL(region)).getByLabelText(C.nameLabel)
    await user.clear(field)
    await user.type(field, "Dana Whitfield")
    await user.click(within(region).getByRole("button", { name: /^Save name/ }))
    expect(await within(region).findByText(C.nameSaveFailed)).toBeVisible()
  })

  it("saves a valid typed name before the Run: PUT then POST, in that order (G4)", async () => {
    const { user, fake } = openOutreach({ items: [ready("referral_request"), notWritten("introduction"), notWritten("application_note")] })
    const region = await REGION()
    const field = within(PANEL(region)).getByLabelText(C.nameLabel)
    await user.clear(field)
    await user.type(field, "Dana Whitfield")
    await user.click(within(region).getByRole("button", { name: /^Write/ }))
    await waitFor(() => expect(fake.requests.length).toBeGreaterThanOrEqual(2))
    expect(fake.requests.map((request) => request.method)).toEqual(["PUT", "POST"])
    expect(fake.requests[0]!.path).toMatch(new RegExp(`/outreach/${SLUGS.referral_request}/reader-name$`))
    expect(fake.requests[1]!.path).toMatch(new RegExp(`/outreach/${SLUGS.referral_request}/write$`))
    expect(fake.requests[1]!.body).toBeNull()
  })

  it("a refused typed name stops Write with the field error and starts nothing (G4)", async () => {
    const { user, fake } = openOutreach({ items: [ready("referral_request"), notWritten("introduction"), notWritten("application_note")] })
    const region = await REGION()
    const field = within(PANEL(region)).getByLabelText(C.nameLabel)
    await user.clear(field)
    await user.type(field, "Amara2")
    await user.click(within(region).getByRole("button", { name: /^Write/ }))
    expect(await within(region).findByRole("alert")).toHaveTextContent(C.nameRefused)
    expect(fake.requests).toEqual([])
  })

  it("keeps one kind's unsaved name when switching tabs and shows the saved name on the others (AC 5.7)", async () => {
    const { user } = openOutreach({
      items: [ready("referral_request", BODY_REFERRAL, { readerName: "Amara Okafor" }), ready("introduction", "An introduction."), notWritten("application_note")],
    })
    const region = await REGION()
    const field = within(PANEL(region)).getByLabelText(C.nameLabel)
    await user.clear(field)
    await user.type(field, "Dana Whitfield")
    await selectTab(C.introduction.label)
    expect(await within(PANEL(await REGION())).findByLabelText(C.nameLabel)).toHaveValue("Amara Okafor")
    await selectTab(C.referral.label)
    expect(within(PANEL(await REGION())).getByLabelText(C.nameLabel)).toHaveValue("Dana Whitfield")
  })
})

describe("outreach-section.feature: nothing else on the page changes", () => {
  it("still renders the page's own heading, Documents and the shell navigation with texts present (AC 1.3)", async () => {
    openOutreach({ items: [ready("referral_request"), ready("introduction"), ready("application_note", "A note.")] })
    expect(await screen.findByRole("heading", { level: 1, name: APPLICATION_NAME })).toBeVisible()
    expect(await screen.findByRole("region", { name: "Documents" })).toBeVisible()
    expect(await screen.findByRole("region", { name: C.heading })).toBeVisible()
  })
})
