import { screen } from "@testing-library/react"
import { http } from "msw"
import { describe, expect, it } from "vitest"

import { routeSkeleton } from "@/components/page-skeletons"
import { applicationCopy, submissionCopy } from "@/entities/application"
import { approvedAnswerCopy } from "@/entities/approved-answer"
import { careerProfileCopy } from "@/entities/career-profile"
import { existingApplicationCopy } from "@/entities/existing-application"
import { jobPostingCopy } from "@/entities/job-posting"
import { renderApp } from "./test-app"
import { server } from "@/shared/testing"

describe("first-load page skeletons", () => {
  it.each([
    ["/dashboard", "Home"],
    ["/profile", careerProfileCopy.pageTitle],
    ["/answers", approvedAnswerCopy.pageTitle],
    ["/postings", jobPostingCopy.pageTitle],
    ["/sources", "Find jobs"],
    ["/existing-applications", existingApplicationCopy.pageTitle],
    ["/documents", applicationCopy.documentsPageTitle],
    ["/activation", submissionCopy.gate.title],
    ["/blocked", submissionCopy.blocked.title],
    ["/uncertain", submissionCopy.uncertain.title],
    ["/settings", "Settings"],
    ["/privacy", "Data and privacy"],
  ])("%s uses the page's own title", (path, title) => {
    expect(routeSkeleton(path)?.title).toBe(title)
  })

  it("/existing-applications repeats the page's own description (C-EXIST-4)", () => {
    expect(routeSkeleton("/existing-applications")?.description).toBe(existingApplicationCopy.pageDescription)
  })

  it.each(["/postings/p-1", "/applications/a-1", "/activation/a-1"])(
    "%s, titled by its data, shows a title bar instead of text",
    (path) => {
      const skeleton = routeSkeleton(path)
      expect(skeleton).not.toBeNull()
      expect(skeleton?.title).toBeUndefined()
    }
  )

  it("has no skeleton for sign-in, the landing page or unknown paths", () => {
    expect(routeSkeleton("/")).toBeNull()
    expect(routeSkeleton("/about")).toBeNull()
    expect(routeSkeleton("/sign-in")).toBeNull()
    expect(routeSkeleton("/nope")).toBeNull()
  })

  it("shows the page's skeleton in the app shell while the session is checked, with no spinner", async () => {
    server.use(http.get("/v1/session", () => new Promise(() => {})))
    renderApp("/settings")

    expect(await screen.findByText("Loading…")).toBeInTheDocument()
    // The shell skeleton is its own chunk (EPIC-0003 first-load budget), so it can arrive a tick later.
    expect(await screen.findByRole("heading", { level: 1, name: "Settings", hidden: true })).toBeInTheDocument()
    expect(document.querySelectorAll('[data-slot="skeleton-text"]').length).toBeGreaterThan(0)
    expect(document.querySelector(".animate-spin")).toBeNull()
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
  })
})
