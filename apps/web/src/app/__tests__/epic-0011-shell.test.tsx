import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { blocked, inviteeMe, newInviteeMe, operatorMe, uncertain, awaitingSample } from "@/shared/testing"
import { entryOf, openEve } from "./epic-0011-helpers"

const sidebarLinks = () =>
  Array.from(document.querySelectorAll('[data-slot="sidebar"] a'))
    .map((a) => a.textContent?.replace(/\s+/g, " ").trim() ?? "")
    .filter(Boolean)

const SIX = ["Home", "Jobs", "Find jobs", "Applications", "Pipeline", "Profile", "Settings"]

describe("Navigation (navigation.feature, advanced-switch.feature)", () => {
  it("NAV:21 Advanced off: the default items in order (Pipeline added in v1.29.0), with no group heading", async () => {
    openEve("/dashboard", { me: inviteeMe() })
    await screen.findByRole("heading", { name: "Home" })
    const items = sidebarLinks().filter((text) => !text.startsWith("Eve"))
    expect(items.map((t) => t.replace(/\s*\d+$/, ""))).toEqual(SIX)
    expect(screen.queryByText("Automatic applying")).not.toBeInTheDocument()
  })

  it("NAV:30 Advanced on: the six plus the Automatic applying group of five, each with its page", async () => {
    openEve("/dashboard", { me: operatorMe() })
    await screen.findByText("Automatic applying")
    for (const [label, href] of [
      ["Check first sends", "/activation"],
      ["Blocked", "/blocked"],
      ["Unsure sends", "/uncertain"],
      ["Form answers", "/answers"],
      ["Pause and cost", "/pause-and-cost"],
    ]) {
      expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", href)
    }
  })

  it("NAV:74 Documents, Job Sources, Stack posts and Existing applications are not in the nav", async () => {
    openEve("/dashboard", { me: operatorMe() })
    await screen.findByText("Automatic applying")
    for (const gone of ["Documents", "Job Sources", "Stack posts", "Approved Answers", "Existing applications"]) {
      expect(screen.queryByRole("link", { name: gone })).not.toBeInTheDocument()
    }
  })

  it("NAV:95 Needs you shows with Advanced off and links to the real page", async () => {
    openEve("/dashboard", { me: inviteeMe(), entries: [entryOf(blocked("captcha", "x"), { roleTitle: "B1" }), entryOf(blocked("login", "x"), { roleTitle: "B2" })] })
    const strip = await screen.findByRole("link", { name: /^Needs you/ })
    expect(strip).toHaveAttribute("href", "/blocked")
    expect(strip).toHaveTextContent("2")
  })

  it("NAV:111 Needs you counts every kind together and opens a list with a row per page", async () => {
    const { user } = openEve("/dashboard", {
      me: inviteeMe(),
      entries: [entryOf(blocked("captcha", "x")), entryOf(uncertain()), entryOf(awaitingSample())],
    })
    const strip = await screen.findByRole("button", { name: /^Needs you/ })
    expect(strip).toHaveTextContent("3")
    await user.click(strip)
    const rows = within(document.querySelector('[data-slot="sidebar"]') as HTMLElement)
    expect(rows.getByRole("link", { name: "See what needs you" })).toHaveAttribute("href", "/blocked")
    expect(rows.getByRole("link", { name: "See what Eve is unsure about" })).toHaveAttribute("href", "/uncertain")
    expect(rows.getByRole("link", { name: "Review applications" })).toHaveAttribute("href", "/activation")
  })

  it("NAV:119 no Needs you when nothing needs the user", async () => {
    openEve("/dashboard", { me: inviteeMe() })
    await screen.findByRole("heading", { name: "Home" })
    expect(screen.queryByRole("link", { name: /^Needs you/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Needs you/ })).not.toBeInTheDocument()
  })

  it("NAV:136 the Advanced group never shows before the flag is read, then shows for an Advanced-on user", async () => {
    openEve("/dashboard", { me: operatorMe(), meDelayMs: 300 })
    expect(screen.queryByText("Automatic applying")).not.toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Home" })).not.toBeInTheDocument()
    expect(await screen.findByText("Automatic applying")).toBeVisible()
  })

  it("NAV:136 an Advanced-off user never sees the group while the read is delayed", async () => {
    openEve("/dashboard", { me: inviteeMe(), meDelayMs: 300 })
    expect(screen.queryByText("Automatic applying")).not.toBeInTheDocument()
    await screen.findByRole("heading", { name: "Home" })
    expect(screen.queryByText("Automatic applying")).not.toBeInTheDocument()
  })

  it("NAV:152 a failed flag read falls back to the safe view with Needs you still shown", async () => {
    openEve("/dashboard", { me: operatorMe(), meFails: true, entries: [entryOf(blocked("captcha", "x"))] })
    await screen.findByRole("heading", { name: "Home" })
    expect(screen.queryByText("Automatic applying")).not.toBeInTheDocument()
    expect(await screen.findByRole("link", { name: /^Needs you/ })).toHaveAttribute("href", "/blocked")
  })
})

describe("Advanced switch (advanced-switch.feature)", () => {
  it("ADV:AC-3.1 Settings has the section with one switch, off for a new account", async () => {
    openEve("/settings", { me: newInviteeMe() })
    const section = await screen.findByRole("region", { name: "Advanced: automatic applying" })
    const toggle = within(section).getByRole("switch", { name: "Show automatic applying" })
    expect(toggle).not.toBeChecked()
    expect(section).toHaveTextContent("Turning it on sends nothing and changes no settings.")
  })

  it("ADV:AC-3.4 turning on writes the flag and shows the group at once; turning off hides it again", async () => {
    const { user, meApi } = openEve("/settings", { me: inviteeMe() })
    const toggle = await screen.findByRole("switch", { name: "Show automatic applying" })
    expect(screen.queryByText("Automatic applying")).not.toBeInTheDocument()
    await user.click(toggle)
    expect(await screen.findByText("Automatic applying")).toBeVisible()
    expect(meApi.writes).toEqual(["advanced:true"])
    await user.click(screen.getByRole("switch", { name: "Show automatic applying" }))
    await waitFor(() => expect(screen.queryByText("Automatic applying")).not.toBeInTheDocument())
    expect(meApi.writes).toEqual(["advanced:true", "advanced:false"])
  })

  it("ADV:AC-3.5 while automatic applying is on the switch is on, disabled and described, with a link to the control", async () => {
    openEve("/settings", { me: operatorMe({ advancedLocked: true }) })
    const toggle = await screen.findByRole("switch", { name: "Show automatic applying" })
    expect(toggle).toBeChecked()
    expect(toggle).toHaveAttribute("aria-disabled", "true")
    expect(toggle).toHaveAccessibleDescription(/Automatic applying is on\. Turn it off first/)
    expect(screen.getByRole("link", { name: "Go to automatic applying" })).toHaveAttribute("href", "/pause-and-cost#automatic")
  })

  it("ADV:AC-3.8 a failed write returns the switch to off and says so", async () => {
    const { user, meApi } = openEve("/settings", { me: inviteeMe() })
    meApi.state.failWrites = true
    await user.click(await screen.findByRole("switch", { name: "Show automatic applying" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save that change. Try again.")
    expect(screen.getByRole("switch", { name: "Show automatic applying" })).not.toBeChecked()
    expect(screen.queryByText("Automatic applying")).not.toBeInTheDocument()
  })

  it("ADV:AC-3.2 with the switch off Settings and Home hide the cost section, pause control, cap and ATS minimum", async () => {
    openEve("/settings", { me: inviteeMe() })
    await screen.findByRole("heading", { name: "Settings" })
    for (const name of ["Monthly cost", "Pause automation"]) {
      expect(screen.queryByText(name)).not.toBeInTheDocument()
    }
    expect(screen.queryByRole("button", { name: "Pause automation" })).not.toBeInTheDocument()
  })

  it("ADV:AC-3.6 a hidden route still loads, with the note and Turn on Advanced; the action reveals nothing new to load", async () => {
    const { user, meApi } = openEve("/blocked", { me: inviteeMe(), entries: [entryOf(blocked("captcha", "x"), { roleTitle: "Visible Role" })] })
    expect(await screen.findByText("This is part of Advanced: automatic applying.")).toBeVisible()
    expect(await screen.findByText(/Visible Role/)).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Turn on Advanced" }))
    await waitFor(() => expect(screen.queryByText("This is part of Advanced: automatic applying.")).not.toBeInTheDocument())
    expect(meApi.writes).toEqual(["advanced:true"])
    expect(await screen.findByText("Automatic applying")).toBeVisible()
  })

  it.each(["/activation", "/uncertain", "/answers", "/pause-and-cost"])("ADV:AC-3.6 %s shows the note with Advanced off", async (route) => {
    openEve(route, { me: inviteeMe() })
    expect(await screen.findByText("This is part of Advanced: automatic applying.")).toBeVisible()
    expect(screen.getByRole("button", { name: "Turn on Advanced" })).toBeVisible()
  })

  it("ADV:AC-3.6 a failed Turn on Advanced keeps the note and says so", async () => {
    const { user, meApi } = openEve("/blocked", { me: inviteeMe() })
    meApi.state.failWrites = true
    await user.click(await screen.findByRole("button", { name: "Turn on Advanced" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't turn on Advanced. Try again.")
    expect(screen.getByText("This is part of Advanced: automatic applying.")).toBeVisible()
  })

  it("NAV:52 Pause and cost shows the Monthly cost section and the pause control", async () => {
    openEve("/pause-and-cost", { me: operatorMe() })
    expect(await screen.findByRole("heading", { name: "Pause and cost" })).toBeVisible()
    expect(await screen.findByRole("heading", { name: "Monthly cost" })).toBeVisible()
    expect(screen.getByRole("heading", { name: "Global pause" })).toBeVisible()
    expect(screen.queryByText("This is part of Advanced: automatic applying.")).not.toBeInTheDocument()
  })

  it("old /settings#cost links land on Pause and cost", async () => {
    const { currentPath } = openEve("/settings#cost", { me: operatorMe() })
    await screen.findByRole("heading", { name: "Pause and cost" })
    expect(currentPath()).toBe("/pause-and-cost#cost")
  })
})
