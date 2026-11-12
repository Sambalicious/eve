import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"
import { CSRF_HEADER, DEFAULT_ROLE_FAMILY_TIERS, ME_PREFERENCES_PATH, PAY_CURRENCIES, type PreferencesValues } from "@eve/contracts"

import {
  createCareerSetupApi,
  createDiscoveryApi,
  createPreferencesApi,
  preferencesRecord,
  server,
  signedInSession,
  type PreferencesApiState,
} from "@/shared/testing"
import { findToast } from "./career-setup-helpers"
import { renderApp } from "./test-app"

/** EPIC-0002 B1: Settings, Job preferences (design-spec.r4 F4, B-PREF-1; r6 B-PREF-3), job-preferences.feature. */
function openSettings(prefs: Partial<PreferencesApiState> = {}, path = "/settings#preferences") {
  const api = createPreferencesApi(prefs)
  const discovery = createDiscoveryApi()
  server.use(signedInSession, ...createCareerSetupApi().handlers, ...discovery.handlers, ...api.handlers)
  const user = userEvent.setup({ delay: null })
  return { ...renderApp(path), api, user }
}

const record = (version: number, values: Partial<PreferencesValues> = {}) => preferencesRecord(version, values)

async function form() {
  return screen.findByRole("region", { name: "Job preferences" })
}
const primary = () => screen.getByRole("button", { name: "Save preferences" })

describe("Settings > Job preferences: the form", () => {
  it(":54 shows the sections in order and saves an edited daily cap as a new version", async () => {
    const { api, user } = openSettings({ record: record(1, { dailyCap: 3 }) })
    const region = await form()
    const headings = within(region).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)
    expect(headings).toEqual([
      "Location and hours",
      "Work arrangement",
      "Exclusions",
      "Pay",
      "Role families",
      "Seniority and employment",
      "Daily cap",
      "Document emphasis",
    ])
    const cap = within(region).getByRole("radiogroup", { name: "Automatic submissions per day" })
    expect(within(cap).getByRole("radio", { name: "3 per day" })).toBeChecked()
    await user.click(within(cap).getByRole("radio", { name: "4 per day" }))
    await user.click(primary())
    await findToast("Preferences saved.")
    expect(api.state.record?.version).toBe(2)
    expect(api.state.record?.values.dailyCap).toBe(4)
    expect((api.puts[0] as { baseVersion: number }).baseVersion).toBe(1)
  })

  it("focuses the section heading when opened from #preferences", async () => {
    openSettings()
    const region = await form()
    await waitFor(() => expect(within(region).getByRole("heading", { level: 2, name: "Job preferences" })).toHaveFocus())
  })

  it("keeps Save preferences inert until a field changes (F4 step 1)", async () => {
    const { api, user } = openSettings()
    await form()
    expect(primary()).toHaveAttribute("aria-disabled", "true")
    await user.click(primary())
    expect(api.puts).toHaveLength(0)
  })

  it(":195 lists every catalog family in order, each a radio group named by its label with four tiers", async () => {
    openSettings()
    const region = await form()
    const frontend = within(region).getByRole("radiogroup", { name: "Frontend" })
    expect(within(frontend).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Tier 1", "Tier 2", "Tier 3", "Excluded"])
    expect(within(frontend).getByRole("radio", { name: "Tier 1" })).toBeChecked()
    expect(within(region).queryByText("Senior frontend")).toBeNull()
    expect(within(region).getAllByRole("radiogroup").filter((g) => within(g).queryByRole("radio", { name: "Excluded" }))).toHaveLength(13)
  })

  it("excluding a family shows the note; excluding all is refused with the error summary focused", async () => {
    const { api, user } = openSettings({ record: record(1, { roleFamilyTiers: Object.fromEntries(Object.keys(DEFAULT_ROLE_FAMILY_TIERS).map((k) => [k, k === "backend" ? 1 : "excluded"])) as PreferencesValues["roleFamilyTiers"] }) })
    const region = await form()
    expect(within(region).getByText("Postings in an excluded family go to the Not a match tab. Eve never applies to them.")).toBeVisible()
    await user.click(within(within(region).getByRole("radiogroup", { name: "Backend" })).getByRole("radio", { name: "Excluded" }))
    await user.click(primary())
    const summary = await screen.findByRole("alert")
    expect(summary).toHaveTextContent("Fix 1 field(s) before saving:")
    await waitFor(() => expect(summary).toHaveFocus())
    expect(within(summary).getByRole("link", { name: "Role families" })).toBeVisible()
    expect(within(region).getByText("Put at least one role family in a tier.")).toBeVisible()
    expect(api.puts).toHaveLength(0)
  })

  it(":201 saves a title keyword; the active line changes only after save", async () => {
    const { api, user } = openSettings()
    const region = await form()
    const keyword = within(region).getByRole("textbox", { name: /Job title must contain/ })
    await user.type(keyword, "react")
    expect(within(region).queryByText(/Eve only applies to jobs whose title contains/)).toBeNull()
    await user.click(primary())
    await findToast("Preferences saved.")
    expect(api.state.record?.values.titleKeyword).toBe("react")
    expect(within(region).getByText(/Eve only applies to jobs whose title contains/)).toHaveTextContent('Eve only applies to jobs whose title contains "react".')
  })

  it(":899 saving a zero-width-only keyword shows the no-rule information line", async () => {
    const { api, user } = openSettings()
    const region = await form()
    await user.type(within(region).getByRole("textbox", { name: /Job title must contain/ }), "\u200b\u200b")
    await user.click(primary())
    expect(await within(region).findByText("This has no letters or numbers to match, so no keyword rule applies.")).toBeVisible()
    expect(api.state.record?.values.titleKeyword).toBeNull()
    expect(within(region).queryByText(/Eve only applies to jobs whose title contains/)).toBeNull()
  })

  it(":947 keeps the keyword's display form", async () => {
    openSettings({ record: record(1, { titleKeyword: "Réact Native" }) })
    const region = await form()
    expect(within(region).getByRole("textbox", { name: /Job title must contain/ })).toHaveValue("Réact Native")
  })

  it(":225 changing the home country adds it locked, keeps the old one, leaves time settings alone", async () => {
    const { user } = openSettings()
    const region = await form()
    await user.click(within(region).getByRole("button", { name: /Home country/ }))
    await user.click(await screen.findByRole("option", { name: "Ghana" }))
    expect(await within(region).findByText("Ghana is now included in your work authorization. Kenya is still there; remove it if it no longer applies. Check your time zone and latest work hour.")).toBeVisible()
    expect(within(region).getByRole("button", { name: "Remove Kenya" })).toBeVisible()
    expect(within(region).queryByRole("button", { name: "Remove Ghana" })).toBeNull()
    expect(within(region).getByRole("combobox", { name: "Time zone" })).toHaveValue("Africa/Nairobi")
    expect(within(region).getByRole("textbox", { name: "Latest work hour" })).toHaveValue("23:00")
  })

  it(":245 a home country that was excluded is removed from the excluded list", async () => {
    const { user } = openSettings({ record: record(1, { excludedRelocationCountries: ["ZA", "EG"] }) })
    const region = await form()
    await user.click(within(region).getByRole("button", { name: /Home country/ }))
    await user.click(await screen.findByRole("option", { name: "South Africa" }))
    expect(await within(region).findByText("South Africa was removed from countries you won't relocate to.")).toBeVisible()
    expect(within(region).queryByRole("button", { name: "Remove South Africa" })).toBeNull()
  })

  it(":308 the currency choice lists exactly the 20 contract currencies with the help line", async () => {
    openSettings()
    const region = await form()
    const select = within(region).getByRole("combobox", { name: "Currency for lowest pay you'll accept" })
    const options = within(select).getAllByRole("option").filter((o) => o.getAttribute("value") !== "")
    expect(options.map((o) => o.getAttribute("value"))).toEqual([...PAY_CURRENCIES])
    expect(options[1]).toHaveTextContent("EUR, Euro")
    expect(within(region).getByText("Only currencies Eve has an exchange rate for can be chosen. Jobs paying in other currencies are still found and marked Unverified for pay.")).toBeVisible()
  })

  it("B1-CW-1 pinned names: Turkey, not the browser's name; distinct currency select names in the summary", async () => {
    const { user } = openSettings({ record: record(1, { excludedRelocationCountries: ["TR"] }) })
    const region = await form()
    expect(within(region).getByRole("button", { name: "Remove Turkey" })).toBeVisible()
    expect(within(region).getByRole("combobox", { name: "Currency for pay you'd like" })).toBeVisible()
    await user.selectOptions(within(region).getByRole("combobox", { name: "Currency for lowest pay you'll accept" }), "EUR")
    const amount = within(region).getByRole("textbox", { name: "Lowest pay you'll accept (gross)" })
    await user.clear(amount)
    await user.click(primary())
    const summary = await screen.findByRole("alert")
    expect(within(summary).getAllByRole("link").map((a) => a.textContent)).toEqual(["Lowest pay you'll accept (gross)"])
  })

  it("names the matched regions from the server in the regions note", async () => {
    openSettings()
    const region = await form()
    expect(within(region).getByText("Which regions include your countries?")).toBeVisible()
    expect(within(region).getByText(/count as open to you: Africa, EMEA\./)).toBeInTheDocument()
  })

  it(":359 refuses latest work hour 00:00 with the exact message and sends nothing", async () => {
    const { api, user } = openSettings()
    const region = await form()
    const hour = within(region).getByRole("textbox", { name: "Latest work hour" })
    await user.clear(hour)
    await user.type(hour, "00:00")
    await user.click(primary())
    expect(await within(region).findByText("Choose a time from 01:00 to 23:59.")).toBeVisible()
    expect(hour).toHaveAttribute("aria-invalid", "true")
    expect(api.puts).toHaveLength(0)
  })

  it("maps a server field error to its field and the summary", async () => {
    const { user } = openSettings()
    server.use(
      http.put(ME_PREFERENCES_PATH, () =>
        HttpResponse.json({ error: { code: "bad_request", message: "The request is not valid.", fieldErrors: [{ field: "timeZone", position: null, problem: "invalid" }] } }, { status: 400 })
      )
    )
    const region = await form()
    await user.click(within(within(region).getByRole("radiogroup", { name: "Automatic submissions per day" })).getByRole("radio", { name: "2 per day" }))
    await user.click(primary())
    const summary = await screen.findByRole("alert")
    expect(within(summary).getByRole("link", { name: "Time zone" })).toBeVisible()
    expect(within(region).getByText("Choose a time zone.")).toBeVisible()
  })
})

describe("Settings > Job preferences: save states (B-PREF-3)", () => {
  it(":690 a successful save shows the toast and the two after-save lines, not C-PREF-APPLIES", async () => {
    const { user } = openSettings()
    const region = await form()
    await user.type(within(region).getByRole("textbox", { name: /Job title must contain/ }), "react")
    await user.click(primary())
    await findToast("Preferences saved.")
    expect(within(region).getByText("Saved 28 Oct 2026, 15:00 EAT. Eve re-checked the jobs it already found. Jobs your changes let back in wait for their next check.")).toBeVisible()
    expect(within(region).getByText("Eligibility changes, like pay or hours, apply from each job's next check. Queued jobs are checked again before they're sent; sent applications keep their results.")).toBeVisible()
    expect(within(region).queryByText(/Changes apply to the next check/)).toBeNull()
    const lines = region.querySelector("[data-slot=after-save]")
    expect(lines).toHaveClass("tabular-nums", "-mt-1")
    expect(within(region).getByText("This saves Job preferences only. It re-checks the jobs Eve already found against your saved keyword and role families. It sends no applications.")).toBeVisible()
  })

  it(":698 a server error keeps every edit and offers Try again; the version is unchanged", async () => {
    const { api, user } = openSettings({ nextSave: "internal_error" })
    const region = await form()
    const keyword = within(region).getByRole("textbox", { name: /Job title must contain/ })
    await user.type(keyword, "react")
    await user.click(within(within(region).getByRole("radiogroup", { name: "Automatic submissions per day" })).getByRole("radio", { name: "2 per day" }))
    await user.click(primary())
    const alert = await within(region).findByText("Couldn't save your preferences. Nothing changed, and your edits are still here. Try again.")
    await waitFor(() => expect(alert.closest("[role=alert]")).toHaveFocus())
    expect(keyword).toHaveValue("react")
    expect(within(region).getByRole("radio", { name: "2 per day" })).toBeChecked()
    expect(api.state.record?.version).toBe(1)
    await user.click(within(region).getByRole("button", { name: "Try again" }))
    await findToast("Preferences saved.")
    expect(api.state.record?.version).toBe(2)
  })

  it(":706 a rate-limited save shows the alert, focuses it and keeps the edits and the action", async () => {
    const { user } = openSettings({ attempts: 10 })
    const region = await form()
    const keyword = within(region).getByRole("textbox", { name: /Job title must contain/ })
    await user.type(keyword, "react")
    await user.click(primary())
    const alert = await within(region).findByText("Too many saves this minute. Nothing changed. Wait up to a minute, then save again.")
    await waitFor(() => expect(alert.closest("[role=alert]")).toHaveFocus())
    expect(keyword).toHaveValue("react")
    expect(primary()).not.toHaveAttribute("aria-disabled")
  })

  it(":665 :675 a stale save shows the D30 conflict alert at the top, keeps the edit, and Reload saves on the latest", async () => {
    const { api, user } = openSettings({ record: record(5) })
    const region = await form()
    api.saveElsewhere()
    await user.click(within(within(region).getByRole("radiogroup", { name: "Automatic submissions per day" })).getByRole("radio", { name: "2 per day" }))
    await user.click(primary())
    const alert = await within(region).findByText("Your preferences changed in another tab. Reload to see the latest. Your edits here aren't saved.")
    await waitFor(() => expect(alert.closest("[role=alert]")).toHaveFocus())
    expect(within(region).getByRole("radio", { name: "2 per day" })).toBeChecked()
    expect(api.state.record?.version).toBe(6)

    await user.click(within(region).getByRole("button", { name: "Reload preferences" }))
    await waitFor(() => expect(within(region).getByRole("radio", { name: "5 per day" })).toBeChecked())
    // DP-B1-02: focus lands on the Job preferences heading, never on body.
    await waitFor(() => expect(within(region).getByRole("heading", { level: 2, name: "Job preferences" })).toHaveFocus())
    expect(within(region).queryByText(/changed in another tab/)).toBeNull()
    await user.click(within(region).getByRole("radio", { name: "2 per day" }))
    await user.click(primary())
    await findToast("Preferences saved.")
    expect(api.state.record?.version).toBe(7)
    expect(api.state.record?.values.dailyCap).toBe(2)
  })

  it("a time zone change inside 24 hours shows the API message verbatim", async () => {
    const { api, user } = openSettings({ record: { ...record(2), timeZoneChangedAt: "2026-10-28T09:00:00.000Z" } })
    const region = await form()
    await user.selectOptions(within(region).getByRole("combobox", { name: "Time zone" }), "Europe/Berlin")
    await user.click(primary())
    expect(await within(region).findByText("You can change your time zone once a day.")).toBeVisible()
    expect(api.state.record?.version).toBe(2)
  })

  it("keeps focus on the primary while saving and sends one request", async () => {
    let release = () => undefined as void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { user } = openSettings()
    let count = 0
    server.use(
      http.put(ME_PREFERENCES_PATH, async ({ request }) => {
        count += 1
        expect(request.headers.get(CSRF_HEADER)).toBeTruthy()
        await gate
        return HttpResponse.json({}, { status: 500 })
      })
    )
    const region = await form()
    await user.click(within(region).getByRole("radio", { name: "2 per day" }))
    await user.click(primary())
    const busy = await screen.findByRole("button", { name: "Saving…" })
    expect(busy).toHaveFocus()
    expect(busy).toHaveAttribute("aria-busy", "true")
    await user.click(busy)
    expect(count).toBe(1)
    release()
  })
})
