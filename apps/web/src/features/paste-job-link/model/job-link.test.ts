import { describe, expect, it } from "vitest"

import { jobLinkProblem } from "./job-link"

describe("jobLinkProblem (discovery.feature: A malformed pasted link is refused)", () => {
  it.each([
    ["", "Paste a job link."],
    ["   ", "Paste a job link."],
    ["not a url", "Enter a full link that starts with https:// or http://."],
    ["ftp://example.com/1", "Enter a full link that starts with https:// or http://."],
    ["https://user:pw@jobs.lever.co/x", "Enter a full link that starts with https:// or http://."],
  ])("refuses %j", (input, error) => {
    expect(jobLinkProblem(input)).toBe(error)
  })

  it.each(["https://jobs.lever.co/globex/abc-123", " http://boards.greenhouse.io/acme/jobs/1042 "])("accepts %j", (input) => {
    expect(jobLinkProblem(input)).toBeNull()
  })
})
