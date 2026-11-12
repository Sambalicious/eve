import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { approvedState, inviteeMe, newInviteeMe, operatorMe, version } from "@/shared/testing"
import { openEve } from "./epic-0011-helpers"

const nothing = { versions: [] }
const drafted = () => ({ ...approvedState(), versions: [version(1, "draft")] })

describe("Upload screen (onboarding.feature)", () => {
  it("ONB:AC-2.1 a first sign-in with nothing uploaded lands on Upload with the consent line and the drop target", async () => {
    const { currentPath } = openEve("/dashboard", { me: newInviteeMe(), career: nothing })
    expect(await screen.findByRole("heading", { name: "Upload your resume" })).toBeVisible()
    expect(currentPath()).toBe("/welcome")
    expect(screen.getByText(/Eve reads your resume and builds a profile/)).toBeVisible()
    expect(screen.getByRole("button", { name: "Choose a file" })).toBeVisible()
  })

  it("ONB:AC-2.2 the Operator sees one consent line with a link to the terms; the drop target waits until he approves", async () => {
    const { user, career } = openEve("/welcome", { me: operatorMe(), career: nothing })
    expect(await screen.findByText(/Eve sends facts from your resume to an AI provider/)).toBeVisible()
    expect(screen.getByRole("link", { name: "Read the terms" })).toHaveAttribute("href", "/privacy#ai-provider")
    expect(screen.getByRole("button", { name: "Choose a file" })).toBeDisabled()
    expect(career.requestsTo("POST", "/v1/ai-provider/approval")).toHaveLength(0)
    await user.click(screen.getByRole("button", { name: "Approve" }))
    expect(await screen.findByText(/has approved the AI provider for this Eve/)).toBeVisible()
    expect(career.requestsTo("POST", "/v1/ai-provider/approval")).toHaveLength(1)
    expect(screen.getByRole("button", { name: "Choose a file" })).toBeEnabled()
  })

  it("ONB:AC-2.2a a non-Operator with approval in place sees a truthful statement and no approve control", async () => {
    openEve("/welcome", { me: inviteeMe(), career: { ...approvedState(), versions: [] } })
    expect(await screen.findByText(/The person who runs your Eve has approved the AI provider for this Eve\./)).toBeVisible()
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Read the terms" })).toBeVisible()
  })

  it("ONB:AC-2.2a a non-Operator without approval is told it is pending, and never meets a control that would answer 403", async () => {
    openEve("/welcome", { me: inviteeMe(), career: nothing })
    expect(await screen.findByText(/Approval is pending from the person who runs your Eve\./)).toBeVisible()
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Choose a file" })).toBeDisabled()
  })

  it("ONB:AC-2.1 after drafting the same screen shows the drafted facts for review", async () => {
    openEve("/welcome", { me: inviteeMe(), career: drafted() })
    expect(await screen.findByRole("heading", { name: "What Eve read" })).toBeVisible()
    expect(screen.getByText("Check these facts. Eve uses nothing until you confirm.")).toBeVisible()
    expect(screen.getByRole("button", { name: "Use this profile" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Choose a file" })).not.toBeInTheDocument()
  })

  it("ONB:AC-2.3 Use this profile calls the existing approval and sends the user to Home", async () => {
    const { user, career, currentPath } = openEve("/welcome", { me: inviteeMe(), career: drafted() })
    await user.click(await screen.findByRole("button", { name: "Use this profile" }))
    await screen.findByRole("heading", { name: "Paste a job" })
    expect(currentPath()).toBe("/dashboard")
    expect(career.requests.filter((r) => r.method === "POST" && /approve/.test(r.path))).toHaveLength(1)
  })

  it("ONB:AC-2.3 the profile is never in use unless chosen: leaving a draft and opening Home shows the single link back", async () => {
    const { career } = openEve("/dashboard", { me: inviteeMe(), career: drafted() })
    expect(await screen.findByText("Eve needs your resume and approval before it can check a job.")).toBeVisible()
    expect(screen.getByRole("link", { name: "Go to upload" })).toHaveAttribute("href", "/welcome")
    expect(career.requests.filter((r) => r.method === "POST")).toHaveLength(0)
  })

  it("the contact full name is asked on this screen: an empty name stops Use this profile and says so", async () => {
    const { user, career, documents } = openEve("/welcome", { me: inviteeMe(), career: drafted() })
    documents.state.contact = { fullName: "", lines: [] }
    const name = await screen.findByRole("textbox", { name: "Full name" })
    await waitFor(() => expect(name).toBeEnabled())
    await user.click(screen.getByRole("button", { name: "Use this profile" }))
    expect(await screen.findByText("Enter your name.")).toBeVisible()
    expect(career.requests.filter((r) => r.method === "POST" && /approve/.test(r.path))).toHaveLength(0)
    await user.type(name, "Bisi Adeyemi")
    await user.click(screen.getByRole("button", { name: "Use this profile" }))
    await screen.findByRole("heading", { name: "Paste a job" })
    expect(documents.state.contact.fullName).toBe("Bisi Adeyemi")
  })

  it("Upload sends a user whose profile is already in use to Home", async () => {
    const { currentPath } = openEve("/welcome", { me: inviteeMe() })
    await screen.findByRole("heading", { name: "Paste a job" })
    expect(currentPath()).toBe("/dashboard")
    void within
  })
})
