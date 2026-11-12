import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { checkPastedLink, isWebUrl, normaliseApplicationUrl } from "./application-url.js"

describe("only http(s) URLs are accepted (SEC-301)", () => {
  it.each(["data:text/html,x", "javascript:alert(1)", "JAVASCRIPT:alert(1)", " file:///etc/passwd", "ftp://x/1", "mailto:a@b.c", "not a url"])(
    "%s is refused",
    (url) => {
      expect(isWebUrl(url)).toBe(false)
    }
  )

  it.each(["https://jobs.lever.co/a/b", "http://example.com/x"])("%s is accepted", (url) => {
    expect(isWebUrl(url)).toBe(true)
  })

  it("a pasted data: link is refused as invalid", () => {
    expect(checkPastedLink("data:text/html,x")).toEqual({ ok: false, code: "job_link_invalid" })
  })
})

describe("normaliseApplicationUrl is idempotent (SEC-511)", () => {
  const PROBES = [
    "https://h.com/x//apply",
    "https://h.com/x/",
    "https://h.com/x/apply/apply",
    "https://h.com/x/apply/",
    "https://h.com/x/apply//apply//",
    "https://h.com/apply",
    "https://h.com//",
    "https://h.com/x/apply?utm_source=a#frag",
    "http://WWW.H.com:80/X/apply/apply/?gh_src=1",
    "https://h.com:8443/x//apply",
    "https://acme.com/careers?gh_jid=111",
    "not a url",
  ]
  // Every URL in the discovery and submission fixtures, read from the files that hold them.
  const FIXTURE_FILES = ["src/discovery/sources/board-readers.spec.ts", "src/discovery/application-url.spec.ts", "test/submission.int-spec.ts"]
  const fixtures = FIXTURE_FILES.flatMap((file) => readFileSync(join(process.cwd(), file), "utf8").match(/https?:\/\/[^\s"'`)\]${}]+/g) ?? [])

  it("reads URLs from the fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(20)
  })

  it.each([...new Set([...PROBES, ...fixtures])])("normalise(normalise(x)) === normalise(x) for %s", (raw) => {
    const once = normaliseApplicationUrl(raw)
    expect(normaliseApplicationUrl(once)).toBe(once)
  })

  it.each([
    ["https://h.com/x//apply", "https://h.com/x"],
    ["https://h.com/x/apply/apply", "https://h.com/x"],
    ["https://h.com/x/", "https://h.com/x"],
    ["https://h.com//", "https://h.com/"],
    // CR5D-03: every leading "www." goes in one pass, so normalising twice changes nothing.
    ["https://www.www.example.com/jobs/1", "https://example.com/jobs/1"],
    ["https://WWW.www.Example.com/jobs/1", "https://example.com/jobs/1"],
  ])("%s -> %s", (raw, expected) => {
    expect(normaliseApplicationUrl(raw)).toBe(expected)
  })
})
