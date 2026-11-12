import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { http, HttpResponse } from "msw"
import { createMemoryRouter, RouterProvider } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import { ME_PREFERENCES_PATH, STEP3_DEFAULTS } from "@eve/contracts"

import { fetchPreferences, type JobPreferences } from "@/entities/job-preferences"
import { server, signedInSession } from "@/shared/testing"
import { createPreferencesApi, preferencesRecord, type PreferencesApiState } from "@/shared/testing/preferences-api"
import { PreferencesStep } from "./preferences-step"

/** Wizard step 3 with the shared form (design-spec.r4 F3; job-preferences.feature :60-:109, :618, :634; onboarding-wizard.feature :769). */
async function openStep(state: Partial<PreferencesApiState> = { record: null }) {
  const api = createPreferencesApi(state)
  server.use(signedInSession, ...api.handlers)
  const prefs: JobPreferences = await fetchPreferences()
  const onSaved = vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const router = createMemoryRouter([{ path: "/", element: <PreferencesStep preferences={prefs} onSaved={onSaved} /> }])
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return { api, onSaved, user: userEvent.setup({ delay: null }) }
}

async function chooseHome(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: /Home country/ }))
  await user.click(await screen.findByRole("option", { name }))
}

async function fillPay(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole("textbox", { name: "Lowest pay you'll accept (gross)" }), "3000")
  await user.selectOptions(screen.getByRole("combobox", { name: "Currency for lowest pay you'll accept" }), "USD")
  await user.type(screen.getByRole("textbox", { name: "Pay you'd like (net)" }), "4500")
  await user.selectOptions(screen.getByRole("combobox", { name: "Currency for pay you'd like" }), "USD")
}

describe("Wizard step 3 (PreferencesStep)", () => {
  it("focuses the step h1 and shows the lead and Save and continue", async () => {
    await openStep()
    const h1 = screen.getByRole("heading", { level: 1, name: "Job preferences" })
    await waitFor(() => expect(h1).toHaveFocus())
    expect(screen.getByText("Eve only applies to jobs that fit these. You can change them later in Settings.")).toBeVisible()
    expect(screen.getByRole("button", { name: "Save and continue" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Save and continue" })).not.toHaveAttribute("aria-disabled")
  })

  it(":98 :103 :109 :634 starts from the server's defaults: sponsorship yes, all levels and types, cap 5, no home country", async () => {
    await openStep()
    expect(within(screen.getByRole("radiogroup", { name: /visa sponsorship/ })).getByRole("radio", { name: "Yes" })).toBeChecked()
    for (const level of ["Junior", "Mid", "Senior", "Staff", "Principal", "Direct", "Employer of record", "Contract"]) {
      expect(screen.getByRole("checkbox", { name: level })).toBeChecked()
    }
    expect(screen.getByRole("radio", { name: "5 per day" })).toBeChecked()
    expect(screen.getByRole("button", { name: /Home country/ })).toHaveAccessibleName("Home country")
    expect(STEP3_DEFAULTS.dailyCap).toBe(5)
  })

  it.each([
    ["Nigeria", "Africa/Lagos"],
    ["Kenya", "Africa/Nairobi"],
    ["Ghana", "Africa/Accra"],
    ["South Africa", "Africa/Johannesburg"],
    ["Egypt", "Africa/Cairo"],
  ])(":60 home country %s defaults the time zone to %s and the hour to 23:00", async (country, zone) => {
    const { user } = await openStep()
    await chooseHome(user, country)
    expect(screen.getByRole("combobox", { name: "Time zone" })).toHaveValue(zone)
    expect(screen.getByRole("textbox", { name: "Latest work hour" })).toHaveValue("23:00")
  })

  it(":93 the home country leads work authorization, locked, and another can be added", async () => {
    const { user } = await openStep()
    await chooseHome(user, "Kenya")
    await user.click(screen.getByRole("button", { name: "Countries you can work in without sponsorship" }))
    await user.click(await screen.findByRole("option", { name: "South Africa" }))
    await user.keyboard("{Escape}")
    const chips = screen.getAllByRole("listitem").map((li) => li.textContent)
    expect(chips.slice(0, 2)).toEqual([expect.stringContaining("Kenya"), expect.stringContaining("South Africa")])
    expect(screen.queryByRole("button", { name: "Remove Kenya" })).toBeNull()
    expect(screen.getByRole("button", { name: "Remove South Africa" })).toBeVisible()
  })

  it(":618 the first save sends baseVersion null, creates version 1 and advances with no toast", async () => {
    const { api, onSaved, user } = await openStep()
    await chooseHome(user, "Kenya")
    await fillPay(user)
    await user.click(screen.getByRole("button", { name: "Save and continue" }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect((api.puts[0] as { baseVersion: number | null }).baseVersion).toBeNull()
    expect(api.state.record?.version).toBe(1)
    expect(screen.queryByText("Preferences saved.")).toBeNull()
    expect(screen.queryByText(/Eve re-checked the jobs it already found/)).toBeNull()
  })

  it("an empty step lists every missing field in the summary and sends nothing", async () => {
    const { api, user } = await openStep()
    await user.click(screen.getByRole("button", { name: "Save and continue" }))
    const summary = await screen.findByRole("alert")
    expect(summary).toHaveTextContent("Fix 6 field(s) before saving:")
    expect(within(summary).getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Home country",
      "Time zone",
      "Lowest pay you'll accept (gross)",
      "Currency for lowest pay you'll accept",
      "Pay you'd like (net)",
      "Currency for pay you'd like",
    ])
    await user.click(within(summary).getAllByRole("link")[0])
    expect(screen.getByRole("button", { name: /Home country/ })).toHaveFocus()
    expect(api.puts).toHaveLength(0)
  })

  it("a server error shows C-WIZ-ERR-1 above the primary and keeps the answers", async () => {
    const { user } = await openStep({ record: preferencesRecord(1), nextSave: "internal_error" })
    await user.click(screen.getByRole("radio", { name: "2 per day" }))
    await user.click(screen.getByRole("button", { name: "Save and continue" }))
    expect(await screen.findByText("Couldn't save this step. Your answers are still here. Try again.")).toBeVisible()
    expect(screen.getByRole("radio", { name: "2 per day" })).toBeChecked()
  })

  it("offline shows C-WIZ-ERR-2", async () => {
    const { user } = await openStep({ record: preferencesRecord(1) })
    server.use(http.put(ME_PREFERENCES_PATH, () => HttpResponse.error()))
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    await user.click(screen.getByRole("radio", { name: "2 per day" }))
    await user.click(screen.getByRole("button", { name: "Save and continue" }))
    expect(await screen.findByText("You're offline. Your answers are still here. Save again when you're back online.")).toBeVisible()
    online.mockRestore()
  })

  it("onboarding :769 a stale save shows the D30 conflict text in step 3", async () => {
    const { api, user } = await openStep({ record: preferencesRecord(1) })
    api.saveElsewhere()
    await user.click(screen.getByRole("radio", { name: "2 per day" }))
    await user.click(screen.getByRole("button", { name: "Save and continue" }))
    expect(await screen.findByText("Your preferences changed in another tab. Reload to see the latest. Your edits here aren't saved.")).toBeVisible()
  })
})
