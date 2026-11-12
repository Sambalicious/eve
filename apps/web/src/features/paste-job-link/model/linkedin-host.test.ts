import { describe, expect, it } from "vitest"

import { isLinkedInHost } from "./linkedin-host"

describe("isLinkedInHost (check-this-job.feature, AC 5.5, D7)", () => {
  it.each([
    "https://www.linkedin.com/posts/acme_hiring-activity-7250000000000000000-abcd",
    "https://linkedin.com/jobs/view/3999999999",
    "https://ng.linkedin.com/posts/acme_hiring-activity-7250000000000000001-wxyz",
    "  https://WWW.LinkedIn.com/feed/update/urn:li:activity:7250000000000000002  ",
    "http://www.linkedin.com/posts/acme_x-activity-7250000000000000003-aaaa",
    "https://linkedin.com./jobs/view/1",
  ])("warns for %j", (url) => {
    expect(isLinkedInHost(url)).toBe(true)
  })

  it.each([
    "https://notlinkedin.com/jobs/1",
    "https://linkedin.com.evil.example/jobs/1",
    "https://boards.greenhouse.io/linkedin/jobs/4012345",
    "https://careers.example.org/?ref=linkedin.com",
    "not a link",
    "",
  ])("does not warn for %j", (url) => {
    expect(isLinkedInHost(url)).toBe(false)
  })
})
