import { screen, waitFor, within } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import { JOB_POSTING_LINKS_PATH } from "@eve/contracts"
import { ownRecord21Oct, pastedPosting, rankedPosting, server, storedPost } from "@/shared/testing"
import { findToast } from "./career-setup-helpers"
import { openDiscovery } from "./discovery-helpers"
import { openHiring, pastes } from "./hiring-view-helpers"

/** The Check this job form lives in a dialog now: open the section's button and return the dialog. */
async function checkDialog(user: { click: (el: HTMLElement) => Promise<void> }): Promise<HTMLElement> {
  const existing = screen.queryByRole("dialog", { name: "Check this job" })
  if (existing) return existing
  const section = await screen.findByRole("region", { name: "Check this job" })
  await user.click(within(section).getByRole("button", { name: "Check this job" }))
  return await screen.findByRole("dialog", { name: "Check this job" })
}

/**
 * gherkin/paste-description.feature, re-paste-and-duplicates.feature and the
 * paste rows of pasted-description-safety.feature: the frontend and "both"
 * rows of gherkin-responsibility.md for the shared paste form (design r1 B1,
 * copy-deck r1). Mocked component checks against the contract-derived fakes
 * (api-contract.md v1.27.0 "MSW handlers"); QA's Playwright tier runs the real API.
 */

const DESCRIPTION = `Senior Frontend Engineer\n\n${"Build merchant dashboards in React and TypeScript. ".repeat(6)}`
const C_PD_30 = "Saved from your description. Eve is checking it."
const C_PD_20 = "Paste a link or the job description."
const C_PD_21 = "Too short to check. Paste the full description, at least 200 characters."
const C_PD_22 = "Over the 30,000-character limit. Shorten it to check this job."
const C_PD_23 = "Enter the job title."
const C_PD_24 = "Enter the company."
const C_PD_27 = "Eve couldn't read the employer's page. Enter the Job title and Company to use your description."
const C_PD_28 = "Eve is still checking your earlier description for this job. Try again when that finishes."
const C_PD_31 = "Eve read the job from the employer's page and used that. Your description wasn't saved."
const C_PD_32 = "Your description is now on the Job Posting you already had. Eve is checking it again."
const C_PD_33 = "You already have this Job Posting. Nothing changed."
const C_PD_34 = "You already have an Application for this job. Its description, documents and ATS score are unchanged."
const C_PD_37 = "Saved. It's checked once the person who runs your Eve turns on checks for you."
const C_PD_38 = "Eve couldn't read the employer's page, so it used your description. You'll apply to this one yourself."
const LI_WARN =
  "Eve can't read LinkedIn, so this link will be saved as not supported. Paste the employer's application link if the post has one, or add the job description."

type User = ReturnType<typeof openDiscovery>["user"]

async function addRegion() {
  return screen.findByRole("region", { name: "Add a job link" })
}

/** Opens the panel in `region` and fills what is given. Text is pasted, as the Candidate would. */
async function fill(
  user: User,
  region: HTMLElement,
  input: { link?: string; description?: string; title?: string; company?: string }
) {
  await user.click(within(region).getByRole("button", { name: "Add the job description" }))
  const description = within(region).getByRole("textbox", { name: /^Job description/ })
  if (input.link) await user.type(within(region).getByRole("textbox", { name: /link/i }), input.link)
  if (input.description) {
    await user.click(description)
    await user.paste(input.description)
  }
  if (input.title) await user.type(within(region).getByRole("textbox", { name: "Job title" }), input.title)
  if (input.company) await user.type(within(region).getByRole("textbox", { name: "Company" }), input.company)
  return description
}

const send = (user: User, region: HTMLElement) => user.click(within(region).getByRole("button", { name: "Check this job" }))
/** The result line: the form's `role="status"` paragraph (the pending spinner is a status too). */
const resultLine = (region: HTMLElement) =>
  waitFor(() => {
    const line = within(region).queryAllByRole("status").find((s) => s.tagName === "P")
    if (!line) throw new Error("no result line")
    return line
  })
const linkPastes = (api: ReturnType<typeof openDiscovery>["api"]) => api.requests.filter((r) => r.path === JOB_POSTING_LINKS_PATH)

describe("PD-1.1 the description panel in each paste form (PD:44)", () => {
  it("closed on load, the toggle reveals the description, its 0 / 30,000 counter, Job title and Company; focus moves to the description", async () => {
    const { user } = openDiscovery("/postings")
    const region = await addRegion()
    const toggle = within(region).getByRole("button", { name: "Add the job description" })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(within(region).queryByRole("textbox", { name: /^Job description/ })).not.toBeInTheDocument()

    await user.click(toggle)
    const description = within(region).getByRole("textbox", { name: "Job description (Optional)" })
    await waitFor(() => expect(description).toHaveFocus())
    expect(within(region).getByRole("textbox", { name: "Job link (Optional)" })).toBeVisible()
    expect(within(region).getByText("0 / 30,000")).toBeVisible()
    expect(description).toHaveAccessibleDescription(
      "Paste the full text if Eve can't read the link, at least 200 characters. You apply yourself. Eve never sends it. 0 of 30,000 characters"
    )
    expect(within(region).getByRole("textbox", { name: "Job title" })).toHaveAccessibleDescription(
      "Needed unless the link is a Greenhouse, Lever or Ashby job. Eve uses what you type, not the text."
    )
    expect(within(region).getByRole("textbox", { name: "Company" })).toBeVisible()
    // The in-field "Check link" gives way to the standalone send button while open.
    expect(within(region).queryByRole("button", { name: "Check link" })).not.toBeInTheDocument()
    expect(within(region).getByRole("button", { name: "Check this job" })).toBeVisible()
  })

  it("the counter shows the trimmed, grouped count as text is pasted", async () => {
    const { user } = openDiscovery("/postings")
    const region = await addRegion()
    await fill(user, region, { description: `  ${"a".repeat(1240)}  ` })
    expect(within(region).getByText("1,240 / 30,000")).toBeVisible()
  })

  it("Check this job on the Hiring view offers the same panel, closed on load", async () => {
    const { user } = openHiring()
    const region = await checkDialog(user)
    await fill(user, region, {})
    expect(within(region).getByRole("textbox", { name: "Application link (Optional)" })).toBeVisible()
    expect(within(region).getByText("0 / 30,000")).toBeVisible()
  })

  it("Remove description clears the description, title and company, closes the panel and returns focus to the toggle", async () => {
    const { user, api } = openDiscovery("/postings")
    const region = await addRegion()
    await fill(user, region, { description: DESCRIPTION, title: "Engineer", company: "Paystack" })
    await user.click(within(region).getByRole("button", { name: "Remove description" }))
    expect(within(region).queryByRole("textbox", { name: /^Job description/ })).not.toBeInTheDocument()
    await waitFor(() => expect(within(region).getByRole("button", { name: "Add the job description" })).toHaveFocus())
    await user.click(within(region).getByRole("button", { name: "Add the job description" }))
    expect(within(region).getByRole("textbox", { name: /^Job description/ })).toHaveValue("")
    expect(within(region).getByRole("textbox", { name: "Job title" })).toHaveValue("")
    expect(linkPastes(api)).toHaveLength(0)
  })
})

describe("Hiring post row panel label (design review P2)", () => {
  it("open, the visible link label is 'Application link (Optional)'; the accessible name keeps the post title", async () => {
    const { user } = openHiring({ stack: { hiringVerification: ownRecord21Oct, hiringPosts: [storedPost({ title: "A Frontend Engineer (React)" })] } })
    const posts = await screen.findByRole("region", { name: "Hiring posts" })
    const row = await within(posts).findByRole("listitem", { name: "A Frontend Engineer (React)" })
    await user.click(within(row).getByRole("button", { name: "Check this job from A Frontend Engineer (React)" }))
    await fill(user, row, {})
    const field = within(row).getByRole("textbox", { name: "Application link for A Frontend Engineer (React) (Optional)" })
    const label = row.querySelector(`label[for="${field.id}"]`) as HTMLElement
    const visible = [...label.querySelectorAll("span")].filter((el) => !el.classList.contains("sr-only")).map((el) => el.textContent)
    expect(visible).toEqual(["Application link", "(Optional)"])
  })
})

describe("PD-1.1 a description-only paste (PD:58, EV:182)", () => {
  it("sends description, title and company, shows C-PD-30 with the Checking badge and View it, clears the form and closes the panel", async () => {
    const { user, api } = openDiscovery("/postings")
    const region = await addRegion()
    await fill(user, region, { description: DESCRIPTION, title: "Senior Frontend Engineer", company: "Paystack" })
    await send(user, region)

    const line = await resultLine(region)
    expect(line).toHaveTextContent(C_PD_30)
    expect(within(line).getByText("Checking")).toBeVisible()
    const created = api.state.postings[0]
    expect(created.origin).toBe("pasted_description")
    expect(created.applicationUrl).toBeNull()
    expect(within(line).getByRole("link", { name: "View it" })).toHaveAttribute("href", `/postings/${created.id}`)
    expect(linkPastes(api).map((r) => r.body)).toEqual([{ description: DESCRIPTION, title: "Senior Frontend Engineer", company: "Paystack" }])
    expect(within(region).queryByRole("textbox", { name: /^Job description/ })).not.toBeInTheDocument()
    const link = within(region).getByRole("textbox", { name: "Job link" })
    expect(link).toHaveValue("")
    await waitFor(() => expect(link).toHaveFocus())
    // EV:182: no hidden line; the result is the one message (no C-LINK-1 toast).
    expect(screen.queryByText(/It goes through the same Eligibility/)).not.toBeInTheDocument()
  })

  it("PD:81 Add a job link, Check this job and a Hiring post row send the same request for the same input", async () => {
    const input = { description: DESCRIPTION, title: "Senior Frontend Engineer", company: "Paystack" }
    const expected = [input]

    const postings = openDiscovery("/postings")
    await fill(postings.user, await addRegion(), input)
    await send(postings.user, await addRegion())
    await resultLine(await addRegion())
    expect(linkPastes(postings.api).map((r) => r.body)).toEqual(expected)
    postings.unmount()

    const hiring = openHiring()
    const check = await checkDialog(hiring.user)
    await fill(hiring.user, check, input)
    await send(hiring.user, check)
    await resultLine(check)
    expect(pastes(hiring.discovery).map((r) => r.body)).toEqual(expected)
  })
})

describe("PD-1.2 link-only stays as today (PD:91, PD:99, PD:112)", () => {
  it("PD:91 with the panel closed, a link sends exactly { url } and toasts C-LINK-1", async () => {
    const { user, api } = openDiscovery("/postings")
    await user.type(await screen.findByRole("textbox", { name: "Job link" }), "https://jobs.lever.co/globex/abc-123")
    await user.click(screen.getByRole("button", { name: "Check link" }))
    expect(await findToast("Checking the link. It goes through the same Eligibility, Match, duplicate and cap rules as discovered postings.")).toBeTruthy()
    expect(linkPastes(api).map((r) => r.body)).toEqual([{ url: "https://jobs.lever.co/globex/abc-123" }])
  })

  it("PD:99 a description of only spaces and line breaks counts as blank: the paste is { url } only", async () => {
    const { user, api } = openDiscovery("/postings")
    const region = await addRegion()
    await fill(user, region, { link: "https://jobs.lever.co/globex/abc-123", description: "   \n\n  \n", title: "Ignored" })
    await send(user, region)
    await waitFor(() => expect(linkPastes(api)).toHaveLength(1))
    expect(linkPastes(api)[0].body).toEqual({ url: "https://jobs.lever.co/globex/abc-123" })
  })

  it("PD:112 with the panel open and both blank, C-PD-20 shows on the link and nothing is sent", async () => {
    const { user, api } = openDiscovery("/postings")
    const region = await addRegion()
    await fill(user, region, {})
    await send(user, region)
    const link = within(region).getByRole("textbox", { name: "Job link (Optional)" })
    expect(within(region).getByText(C_PD_20)).toBeVisible()
    expect(link).toHaveAttribute("aria-invalid", "true")
    expect(link).toHaveFocus()
    expect(linkPastes(api)).toHaveLength(0)
  })

  it("the LinkedIn warning is for link-only pastes: with a description, Check this job sends at once", async () => {
    const { user, discovery } = openHiring()
    const region = await checkDialog(user)
    await fill(user, region, {
      link: "https://www.linkedin.com/jobs/view/4012345678",
      description: DESCRIPTION,
      title: "Senior Frontend Engineer",
      company: "Paystack",
    })
    await send(user, region)
    expect(await resultLine(region)).toHaveTextContent(C_PD_30)
    expect(screen.queryByText(LI_WARN)).not.toBeInTheDocument()
    expect(pastes(discovery)[0].body).toEqual({
      url: "https://www.linkedin.com/jobs/view/4012345678",
      description: DESCRIPTION,
      title: "Senior Frontend Engineer",
      company: "Paystack",
    })
  })
})

describe("PD-1.3, PD-1.4 field validation (PD:167, PD:191, PD:205)", () => {
  it("PD:167 over 30,000 shows C-PD-22 live, the counter turns destructive and send is unavailable: no request", async () => {
    const { user, api } = openDiscovery("/postings")
    const region = await addRegion()
    const description = await fill(user, region, { description: "a".repeat(30_001), title: "T", company: "C" })
    expect(within(region).getByText(C_PD_22)).toBeVisible()
    expect(description).toHaveAttribute("aria-invalid", "true")
    expect(within(region).getByText("30,001 / 30,000").parentElement).toHaveClass("text-destructive-text")
    const button = within(region).getByRole("button", { name: "Check this job" })
    expect(button).toHaveAttribute("aria-disabled", "true")
    // DR-02: shown as unavailable (data-disabled dims it) yet still focusable (no native disabled).
    expect(button).toHaveAttribute("data-disabled")
    expect(button).not.toBeDisabled()
    expect(button).toHaveAccessibleDescription(C_PD_22)
    await user.click(button)
    expect(linkPastes(api)).toHaveLength(0)
    // A keyboard user can reach it and activating it does nothing.
    button.focus()
    expect(button).toHaveFocus()
    await user.keyboard("{Enter}")
    expect(button).toHaveFocus()
    expect(linkPastes(api)).toHaveLength(0)

    // Back under the limit, all three clear.
    await user.click(description)
    await user.keyboard("{Control>}{End}{/Control}{Backspace}")
    expect(within(region).queryByText(C_PD_22)).not.toBeInTheDocument()
    expect(button).not.toHaveAttribute("aria-disabled", "true")
    expect(button).not.toHaveAttribute("data-disabled")
  })

  it("a description under 200 characters shows C-PD-21 on send, with focus on the description", async () => {
    const { user, api } = openDiscovery("/postings")
    const region = await addRegion()
    const description = await fill(user, region, { description: "a".repeat(199), title: "T", company: "C" })
    expect(within(region).queryByText(C_PD_21)).not.toBeInTheDocument()
    await send(user, region)
    expect(within(region).getByText(C_PD_21)).toBeVisible()
    expect(description).toHaveFocus()
    expect(linkPastes(api)).toHaveLength(0)
  })

  it("PD:191 a description-only paste without names shows C-PD-23 and C-PD-24, focus on Job title, nothing sent", async () => {
    const { user, api } = openDiscovery("/postings")
    const region = await addRegion()
    await fill(user, region, { description: DESCRIPTION })
    await send(user, region)
    const title = within(region).getByRole("textbox", { name: "Job title" })
    expect(title).toHaveAccessibleDescription(expect.stringContaining(C_PD_23))
    expect(within(region).getByRole("textbox", { name: "Company" })).toHaveAccessibleDescription(expect.stringContaining(C_PD_24))
    expect(title).toHaveFocus()
    expect(linkPastes(api)).toHaveLength(0)
  })

  it("PD:205 a non-ATS link without names: the server's 422 maps each fieldErrors entry onto its field", async () => {
    const { user, api } = openDiscovery("/postings")
    const region = await addRegion()
    await fill(user, region, { link: "https://careers.paystack.com/jobs/42", description: DESCRIPTION })
    await send(user, region)
    const title = within(region).getByRole("textbox", { name: "Job title" })
    await waitFor(() => expect(title).toHaveAttribute("aria-invalid", "true"))
    expect(within(region).getByText(C_PD_23)).toBeVisible()
    expect(within(region).getByText(C_PD_24)).toBeVisible()
    expect(title).toHaveFocus()
    expect(linkPastes(api)).toHaveLength(1)
    expect(api.state.postings).toHaveLength(0)
  })

  it("names over 200 characters are refused on send (C-PD-25, C-PD-25b), never cut", async () => {
    const { user } = openDiscovery("/postings")
    const region = await addRegion()
    const long = "x".repeat(201)
    await fill(user, region, { description: DESCRIPTION })
    await user.click(within(region).getByRole("textbox", { name: "Job title" }))
    await user.paste(long)
    await user.click(within(region).getByRole("textbox", { name: "Company" }))
    await user.paste(long)
    await send(user, region)
    expect(within(region).getByText("Job title is over 200 characters. Shorten it.")).toBeVisible()
    expect(within(region).getByText("Company is over 200 characters. Shorten it.")).toBeVisible()
    expect(within(region).getByRole("textbox", { name: "Job title" })).toHaveValue(long)
  })
})

describe("PD-5.1 Greenhouse, Lever or Ashby link with a description (RP:46, RP:96, RP:113)", () => {
  it("RP:46 a readable ATS link uses the employer's page: C-PD-31 and View it", async () => {
    const { user, api } = openDiscovery("/postings")
    const region = await addRegion()
    await fill(user, region, { link: "https://boards.greenhouse.io/acme/jobs/1042", description: DESCRIPTION })
    await send(user, region)
    const line = await resultLine(region)
    expect(line).toHaveTextContent(C_PD_31)
    expect(within(line).getByRole("link", { name: "View it" })).toHaveAttribute("href", `/postings/${api.state.postings[0].id}`)
    expect(api.state.postings[0].origin).not.toBe("pasted_description")
  })

  it("RP:96 a failed lookup with both names uses the description: C-PD-38", async () => {
    const { user, api } = openDiscovery("/postings")
    const region = await addRegion()
    await fill(user, region, { link: "https://boards.greenhouse.io/acme/jobs/4019999", description: DESCRIPTION, title: "Engineer", company: "Acme" })
    await send(user, region)
    expect(await resultLine(region)).toHaveTextContent(C_PD_38)
    expect(api.state.postings[0]).toMatchObject({ origin: "pasted_description", applyMode: "manual" })
  })

  it("RP:113 a failed lookup with no names shows C-PD-27, keeps every value, marks the names and focuses Job title", async () => {
    const { user, api } = openDiscovery("/postings")
    const region = await addRegion()
    const link = "https://boards.greenhouse.io/acme/jobs/4019999"
    await fill(user, region, { link, description: DESCRIPTION })
    await send(user, region)
    const alert = await within(region).findByRole("alert")
    expect(alert).toHaveTextContent(C_PD_27)
    const title = within(region).getByRole("textbox", { name: "Job title" })
    const company = within(region).getByRole("textbox", { name: "Company" })
    expect(title).toHaveAttribute("aria-invalid", "true")
    expect(company).toHaveAttribute("aria-invalid", "true")
    expect(title).toHaveAccessibleDescription(expect.stringContaining(C_PD_27))
    expect(title).toHaveFocus()
    expect(within(region).getByRole("textbox", { name: "Job link (Optional)" })).toHaveValue(link)
    expect(within(region).getByRole("textbox", { name: /^Job description/ })).toHaveValue(DESCRIPTION)
    expect(api.state.postings).toHaveLength(0)

    // Editing any field clears the alert.
    await user.type(title, "Engineer")
    expect(within(region).queryByText(C_PD_27)).not.toBeInTheDocument()
  })
})

describe("PD-5.2 to PD-5.4 re-paste outcomes (RP:130, RP:148, RP:182, RP:205)", () => {
  const LINK = "https://careers.paystack.com/jobs/42"

  it("RP:130 a description for a held link with no text attaches: C-PD-32 and View it to the new posting id", async () => {
    const held = rankedPosting({ applicationUrl: LINK, applyUrl: LINK, origin: "pasted_link", postingText: "", status: "skipped", skipReason: "unsupported_application_system", rank: null })
    const { user, api } = openDiscovery("/postings", { postings: [held] })
    const region = await addRegion()
    await fill(user, region, { link: LINK, description: DESCRIPTION, title: "Engineer", company: "Paystack" })
    await send(user, region)
    const line = await resultLine(region)
    expect(line).toHaveTextContent(C_PD_32)
    expect(within(line).getByText("Checking")).toBeVisible()
    const fresh = api.state.postings[0]
    expect(fresh.id).not.toBe(held.id)
    expect(within(line).getByRole("link", { name: "View it" })).toHaveAttribute("href", `/postings/${fresh.id}`)
  })

  it("RP:148 a new description replaces an earlier one with no Application: C-PD-32", async () => {
    const held = pastedPosting({ applicationUrl: LINK, applyUrl: LINK })
    const { user } = openDiscovery("/postings", { postings: [held] })
    const region = await addRegion()
    await fill(user, region, { link: LINK, description: DESCRIPTION, title: "Engineer", company: "Paystack" })
    await send(user, region)
    const line = await resultLine(region)
    expect(line).toHaveTextContent(C_PD_32)
    expect(within(line).getByRole("link", { name: "View it" })).toHaveAttribute("href", `/postings/${held.id}`)
  })

  it("RP:182 a link that already has an Application: C-PD-34 with 'Go to that Application'; the form keeps its values", async () => {
    const held = pastedPosting({ applicationUrl: LINK, applyUrl: LINK })
    const appId = "30000000-0000-4000-8000-00000000abcd"
    const { user } = openDiscovery("/postings", {
      postings: [held],
      existingApplication: (id) => (id === held.id ? { id: appId, submissionState: null, isSample: false, detailsDeleted: false } : null),
    })
    const region = await addRegion()
    await fill(user, region, { link: LINK, description: DESCRIPTION, title: "Engineer", company: "Paystack" })
    await send(user, region)
    const line = await resultLine(region)
    expect(line).toHaveTextContent(C_PD_34)
    expect(within(line).getByRole("link", { name: "Go to that Application" })).toHaveAttribute("href", `/applications/${appId}`)
    expect(within(line).queryByText("Checking")).not.toBeInTheDocument()
    expect(within(region).getByRole("textbox", { name: /^Job description/ })).toHaveValue(DESCRIPTION)
    expect(within(region).getByRole("textbox", { name: "Job title" })).toHaveValue("Engineer")
    // DR-01: focus stays on send.
    expect(within(region).getByRole("button", { name: "Check this job" })).toHaveFocus()
  })

  it("RP:205 an identical description-only paste: C-PD-33 and View it to the earlier posting, values kept", async () => {
    const { user, api } = openDiscovery("/postings")
    const region = await addRegion()
    const input = { description: DESCRIPTION, title: "Senior Frontend Engineer", company: "Paystack" }
    await fill(user, region, input)
    await send(user, region)
    await resultLine(region)
    const earlier = api.state.postings[0]
    await fill(user, region, input)
    await send(user, region)
    const line = await waitFor(() => {
      const status = within(region).getByRole("status")
      expect(status).toHaveTextContent(C_PD_33)
      return status
    })
    expect(within(line).getByRole("link", { name: "View it" })).toHaveAttribute("href", `/postings/${earlier.id}`)
    expect(api.state.postings).toHaveLength(1)
    expect(within(region).getByRole("textbox", { name: /^Job description/ })).toHaveValue(DESCRIPTION)
    // DR-01: focus stays on send.
    expect(within(region).getByRole("button", { name: "Check this job" })).toHaveFocus()
  })

  it("DR-01 while the paste is pending, send keeps focus: it is aria-disabled, never natively disabled", async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { user } = openDiscovery("/postings")
    // Registered after the fakes so it runs first; it returns nothing after the gate, so the contract fake answers.
    server.use(http.post(JOB_POSTING_LINKS_PATH, async () => { await gate }))
    const region = await addRegion()
    await fill(user, region, { description: DESCRIPTION, title: "Engineer", company: "Paystack" })
    const button = within(region).getByRole("button", { name: "Check this job" })
    button.focus()
    await user.keyboard("{Enter}")
    await waitFor(() => expect(button).toHaveAttribute("aria-disabled", "true"))
    expect(button).not.toBeDisabled()
    expect(button).toHaveFocus()
    release()
    await resultLine(region)
  })

  it("re-paste while the posting is still checking: C-PD-28 above send, values kept, focus on send", async () => {
    const held = pastedPosting({ applicationUrl: LINK, applyUrl: LINK, status: "checking", rank: null })
    const { user } = openDiscovery("/postings", { postings: [held] })
    const region = await addRegion()
    await fill(user, region, { link: LINK, description: DESCRIPTION, title: "Engineer", company: "Paystack" })
    await send(user, region)
    expect(await within(region).findByRole("alert")).toHaveTextContent(C_PD_28)
    expect(within(region).getByRole("button", { name: "Check this job" })).toHaveFocus()
    expect(within(region).getByRole("textbox", { name: /^Job description/ })).toHaveValue(DESCRIPTION)
  })
})

describe("PD-6.3, PD-6.4 waiting results (SAFE:152, SAFE:195)", () => {
  it("SAFE:152 during a cost pause the description is saved as waiting: C-PD-36 with the WAT resume date", async () => {
    const { user } = openDiscovery("/postings", { pasteWaitingReason: "cost_pause" })
    const region = await addRegion()
    await fill(user, region, { description: DESCRIPTION, title: "Engineer", company: "Paystack" })
    await send(user, region)
    const line = await resultLine(region)
    expect(line).toHaveTextContent(
      /^Saved\. Eve checks it when paid automation resumes on \d{1,2} [A-Z][a-z]{2} \d{4}, or sooner if the ceiling is raised\./
    )
    expect(within(line).getByText("Checking")).toBeVisible()
    expect(within(line).getByRole("link", { name: "View it" })).toBeVisible()
  })

  it("SAFE:195 an invitee whose postings may not be checked: C-PD-37", async () => {
    const { user } = openDiscovery("/postings", { pasteWaitingReason: "checks_not_enabled" })
    const region = await addRegion()
    await fill(user, region, { description: DESCRIPTION, title: "Engineer", company: "Paystack" })
    await send(user, region)
    expect(await resultLine(region)).toHaveTextContent(C_PD_37)
  })
})

describe("B5 send failure", () => {
  it("a network failure with a description toasts C-ERR-2 with 'check the job' and keeps the panel and values", async () => {
    const { user } = openDiscovery("/postings")
    server.use(http.post(JOB_POSTING_LINKS_PATH, () => HttpResponse.error()))
    const region = await addRegion()
    await fill(user, region, { description: DESCRIPTION, title: "Engineer", company: "Paystack" })
    await send(user, region)
    expect(await findToast("Couldn't check the job. Nothing changed. Try again.")).toBeTruthy()
    expect(within(region).getByRole("textbox", { name: /^Job description/ })).toHaveValue(DESCRIPTION)
  })
})
