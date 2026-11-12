import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { readEmployerBoard } from "./ats-readers.js"
import { hasJobBody, lookUpAtsPosting } from "./ats-lookup.js"
import { BoardReadError, createBoardHttp } from "./board-http.js"
import { decodeEntities, htmlToText } from "./discovered-posting.js"
import { applyModeFor } from "../pre-filters.js"
import { epochCandidate, resolvePostedDate } from "./posted-date.js"
import { readRemoteBoard, resolveThroughAts } from "./remote-boards.js"

const server = setupServer()
const requested: string[] = []
const boardHttp = createBoardHttp({ sleep: async () => undefined })

beforeAll(() => server.listen({ onUnhandledFrame: "error" }))
afterEach(() => {
  server.resetHandlers()
  requested.length = 0
})
afterAll(() => server.close())

function record() {
  server.events.on("request:start", ({ request }) => requested.push(request.url))
}

describe("Greenhouse, Lever and Ashby board readers (public GET APIs)", () => {
  it("reads a Greenhouse board with the requisition ID and absolute URL (AC 3.2)", async () => {
    server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/acme/jobs", ({ request }) => {
        expect(new URL(request.url).searchParams.get("content")).toBe("true")
        return HttpResponse.json({
          jobs: [
            {
              id: 1042,
              title: "Senior Frontend Engineer",
              absolute_url: "https://boards.greenhouse.io/acme/jobs/1042?gh_src=abc",
              requisition_id: "R-1042",
              content: "&lt;p&gt;Remote, open to candidates in Nigeria.&lt;/p&gt;",
              location: { name: "Remote" },
            },
            { id: 7, title: "Designer", absolute_url: "https://boards.greenhouse.io/acme/jobs/7", requisition_id: null, content: null },
          ],
        })
      })
    )
    const postings = await readEmployerBoard(boardHttp, { company: "Acme Payments", applicationSystem: "greenhouse", boardToken: "acme" })
    expect(postings[0]).toMatchObject({
      applicationUrl: "https://boards.greenhouse.io/acme/jobs/1042",
      requisitionId: "R-1042",
      company: "Acme Payments",
      manualOnly: false,
      attribution: null,
    })
    expect(postings[0]?.text).toContain("Remote, open to candidates in Nigeria.")
    expect(postings[0]?.structured.workplace).toBe("remote")
    // Fallback requisition key: the Application System's posting ID.
    expect(postings[1]?.requisitionId).toBe("7")
  })

  it("reads a Lever board, using the posting ID as the requisition key and structured pay", async () => {
    server.use(
      http.get("https://api.lever.co/v0/postings/globex", () =>
        HttpResponse.json([
          {
            id: "abc-123",
            text: "Frontend Tech Lead",
            hostedUrl: "https://jobs.lever.co/globex/abc-123",
            applyUrl: "https://jobs.lever.co/globex/abc-123/apply",
            workplaceType: "remote",
            descriptionPlain: "Lead our web team.",
            categories: { commitment: "Full-time" },
            salaryRange: { currency: "USD", interval: "per-year-salary", min: 90000, max: 120000 },
          },
        ])
      )
    )
    const [posting] = await readEmployerBoard(boardHttp, { company: "Globex", applicationSystem: "lever", boardToken: "globex" })
    expect(posting).toMatchObject({
      applicationUrl: "https://jobs.lever.co/globex/abc-123",
      requisitionId: "abc-123",
      applyUrl: "https://jobs.lever.co/globex/abc-123/apply",
    })
    expect(posting?.structured).toMatchObject({ workplace: "remote", employmentType: "direct", pay: { currency: "USD", max: 120000, period: "year" } })
  })

  it("reads an Ashby board with compensation and skips unlisted postings", async () => {
    server.use(
      http.get("https://api.ashbyhq.com/posting-api/job-board/umbrella", ({ request }) => {
        expect(new URL(request.url).searchParams.get("includeCompensation")).toBe("true")
        return HttpResponse.json({
          jobs: [
            {
              id: "5f2e",
              title: "Senior Product Engineer",
              jobUrl: "https://jobs.ashbyhq.com/umbrella/5f2e",
              applyUrl: "https://jobs.ashbyhq.com/umbrella/5f2e/application",
              isRemote: true,
              employmentType: "FullTime",
              descriptionPlain: "Build product.",
              compensation: {
                summaryComponents: [{ compensationType: "Salary", interval: "1 YEAR", currencyCode: "EUR", minValue: 70000, maxValue: 90000 }],
              },
            },
            { id: "hidden", title: "Secret", jobUrl: "https://jobs.ashbyhq.com/umbrella/hidden", isListed: false },
          ],
        })
      })
    )
    const postings = await readEmployerBoard(boardHttp, { company: "Umbrella", applicationSystem: "ashby", boardToken: "umbrella" })
    expect(postings).toHaveLength(1)
    expect(postings[0]?.structured.pay).toMatchObject({ currency: "EUR", max: 90000, period: "year" })
  })

  it("an empty board yields no postings", async () => {
    server.use(http.get("https://boards-api.greenhouse.io/v1/boards/empty/jobs", () => HttpResponse.json({ jobs: [] })))
    expect(await readEmployerBoard(boardHttp, { company: "Empty", applicationSystem: "greenhouse", boardToken: "empty" })).toEqual([])
  })

  it("retries 429 and 5xx with backoff, then gives up", async () => {
    let calls = 0
    server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/flaky/jobs", () => {
        calls += 1
        return calls < 3 ? new HttpResponse(null, { status: calls === 1 ? 429 : 503 }) : HttpResponse.json({ jobs: [] })
      })
    )
    expect(await readEmployerBoard(boardHttp, { company: "F", applicationSystem: "greenhouse", boardToken: "flaky" })).toEqual([])
    expect(calls).toBe(3)

    server.use(http.get("https://boards-api.greenhouse.io/v1/boards/down/jobs", () => new HttpResponse(null, { status: 500 })))
    await expect(readEmployerBoard(boardHttp, { company: "D", applicationSystem: "greenhouse", boardToken: "down" })).rejects.toBeInstanceOf(
      BoardReadError
    )
  })

  it("never fetches a host outside the board API allowlist", async () => {
    await expect(boardHttp.getJson("https://himalayas.app.evil.example/jobs")).rejects.toMatchObject({ reason: "host_not_allowed" })
    await expect(boardHttp.getJson("https://boards.greenhouse.io/acme/jobs/1")).rejects.toMatchObject({ reason: "host_not_allowed" })
  })

  it("looks up a pasted Greenhouse link through the job API, with pay transparency", async () => {
    server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/acme/jobs/1042", () =>
        HttpResponse.json({
          id: 1042,
          title: "Senior Frontend Engineer",
          absolute_url: "https://boards.greenhouse.io/acme/jobs/1042",
          requisition_id: "R-1042",
          content: "Remote.",
          pay_input_ranges: [{ min_cents: 6_000_000, max_cents: 8_000_000, currency_type: "USD" }],
        })
      )
    )
    const posting = await lookUpAtsPosting(boardHttp, "https://boards.greenhouse.io/acme/jobs/1042")
    expect(posting).toMatchObject({ requisitionId: "R-1042", structured: { pay: { max: 80_000, period: "year" } } })
  })

  it("a closed pasted posting (404) resolves to null", async () => {
    server.use(http.get("https://api.lever.co/v0/postings/globex/gone", () => new HttpResponse(null, { status: 404 })))
    expect(await lookUpAtsPosting(boardHttp, "https://jobs.lever.co/globex/gone")).toBeNull()
  })
})

describe("remote boards", () => {
  it("Himalayas: always manual, Apply from applicationLink, credit shown", async () => {
    record()
    server.use(
      http.get("https://himalayas.app/jobs/api", () =>
        HttpResponse.json({
          jobs: [
            {
              title: "Senior Frontend Engineer",
              companyName: "Coralogix",
              applicationLink: "https://himalayas.app/companies/coralogix/jobs/senior-frontend-engineer?utm_source=api",
              guid: "himalayas-1",
              locationRestrictions: [],
              maxSalary: 120000,
              minSalary: 90000,
              currency: "USD",
              salaryPeriod: "year",
              description: "<p>Apply at https://boards.greenhouse.io/coralogix/jobs/55</p>",
            },
          ],
        })
      )
    )
    const [posting] = await readRemoteBoard(boardHttp, "himalayas")
    expect(posting).toMatchObject({
      applyUrl: "https://himalayas.app/companies/coralogix/jobs/senior-frontend-engineer?utm_source=api",
      manualOnly: true,
      attribution: { name: "Himalayas" },
      structured: { locationRestrictions: [] },
    })
    // Never swapped for the ATS link, and no ATS lookup is made.
    expect(await resolveThroughAts(boardHttp, posting!)).toBe(posting)
    expect(requested.every((url) => url.startsWith("https://himalayas.app/jobs/api"))).toBe(true)
  })

  it("Remote OK: skips the legal notice, credits the board, resolves an ATS link through the ATS API", async () => {
    server.use(
      http.get("https://remoteok.com/api", () =>
        HttpResponse.json([
          { legal: "API Terms of Service: Please link back..." },
          {
            id: "1137542",
            position: "Senior React Engineer",
            company: "Initech",
            url: "https://remoteOK.com/remote-jobs/senior-react-engineer-initech-1137542",
            apply_url: "https://remoteOK.com/remote-jobs/senior-react-engineer-initech-1137542",
            description: "Apply here: https://jobs.lever.co/initech/xyz-9.",
          },
          { id: "2", position: "Backend Dev", company: "Other", url: "https://remoteok.com/remote-jobs/2", description: "No ATS here." },
        ])
      ),
      http.get("https://api.lever.co/v0/postings/initech/xyz-9", () =>
        HttpResponse.json({ id: "xyz-9", text: "Senior React Engineer", hostedUrl: "https://jobs.lever.co/initech/xyz-9" })
      )
    )
    const postings = await readRemoteBoard(boardHttp, "remoteok")
    expect(postings).toHaveLength(2)
    const resolved = await resolveThroughAts(boardHttp, postings[0]!)
    expect(resolved).toMatchObject({
      applicationUrl: "https://jobs.lever.co/initech/xyz-9",
      requisitionId: "xyz-9",
      attribution: { name: "Remote OK", url: "https://remoteOK.com/remote-jobs/senior-react-engineer-initech-1137542" },
    })
    const unresolved = await resolveThroughAts(boardHttp, postings[1]!)
    expect(unresolved.applicationUrl).toBe("https://remoteok.com/remote-jobs/2")
  })

  it("We Work Remotely: reads the official RSS feed with credit", async () => {
    server.use(
      http.get("https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss", () =>
        HttpResponse.text(
          `<?xml version="1.0"?><rss><channel><item><title>Acme: Senior Frontend Engineer</title><region>Anywhere in the World</region><type>Full-Time</type><link>https://weworkremotely.com/remote-jobs/acme-senior-frontend</link><guid>https://weworkremotely.com/remote-jobs/acme-senior-frontend</guid><description><![CDATA[<p>React &amp; TypeScript</p>]]></description></item></channel></rss>`,
          { headers: { "content-type": "application/rss+xml" } }
        )
      )
    )
    const [posting] = await readRemoteBoard(boardHttp, "weworkremotely")
    expect(posting).toMatchObject({ company: "Acme", title: "Senior Frontend Engineer", attribution: { name: "We Work Remotely" }, manualOnly: false })
    expect(posting?.text).toContain("React & TypeScript")
    expect(posting?.text).toContain("Region: Anywhere in the World")
  })
})

describe("slice 5 prework: any Greenhouse, Lever or Ashby job on Remote OK or WWR is automatic (Candidate default)", () => {
  it("a WWR posting linking an Ashby job of a company not on the employer list resolves and is automatic", async () => {
    server.use(
      http.get("https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss", () =>
        HttpResponse.text(
          `<rss><channel><item><title>Unlisted Co: Senior Frontend Engineer</title><link>https://weworkremotely.com/remote-jobs/unlisted</link><description><![CDATA[Apply at https://jobs.ashbyhq.com/unlisted-co/abc-123]]></description></item></channel></rss>`
        )
      ),
      http.get("https://api.ashbyhq.com/posting-api/job-board/unlisted-co", () =>
        HttpResponse.json({ jobs: [{ id: "abc-123", title: "Senior Frontend Engineer", jobUrl: "https://jobs.ashbyhq.com/unlisted-co/abc-123", applyUrl: "https://jobs.ashbyhq.com/unlisted-co/abc-123/application", isRemote: true }] })
      )
    )
    const [posting] = await readRemoteBoard(boardHttp, "weworkremotely")
    const resolved = await resolveThroughAts(boardHttp, posting!)
    expect(resolved.applicationUrl).toBe("https://jobs.ashbyhq.com/unlisted-co/abc-123")
    expect(resolved.attribution).toMatchObject({ name: "We Work Remotely" })
    expect(applyModeFor(resolved.applicationUrl, resolved.manualOnly)).toBe("automatic")
  })

  it("an unresolved Remote OK posting stays manual", () => {
    expect(applyModeFor("https://remoteok.com/remote-jobs/2", false)).toBe("manual")
  })
})

describe("MSW guard", () => {
  it("an unmocked board request fails instead of reaching the network", async () => {
    await expect(boardHttp.getJson("https://api.ashbyhq.com/posting-api/job-board/not-mocked")).rejects.toBeInstanceOf(BoardReadError)
  })
})

describe("repair wave 2: unsafe URLs and bad entities (SEC-301, SEC-304)", () => {
  it.each(["data:text/html,<script>alert(1)</script>", "javascript:alert(1)", "file:///etc/passwd", "ftp://jobs.example/1"])(
    "a Himalayas posting whose applicationLink is %s is dropped, the rest kept",
    async (link) => {
      server.use(
        http.get("https://himalayas.app/jobs/api", () =>
          HttpResponse.json({
            jobs: [
              { title: "Bad", companyName: "Evil", applicationLink: link },
              { title: "Good", companyName: "Fine", applicationLink: "https://himalayas.app/companies/fine/jobs/good" },
            ],
          })
        )
      )
      const postings = await readRemoteBoard(boardHttp, "himalayas")
      expect(postings.map((posting) => posting.title)).toEqual(["Good"])
    }
  )

  it("a Remote OK posting with a data: url is dropped", async () => {
    server.use(
      http.get("https://remoteok.com/api", () =>
        HttpResponse.json([
          { legal: "notice" },
          { id: "1", position: "Bad", company: "Evil", url: "data:text/html,x" },
          { id: "2", position: "Good", company: "Fine", url: "https://remoteok.com/remote-jobs/2" },
        ])
      )
    )
    expect((await readRemoteBoard(boardHttp, "remoteok")).map((posting) => posting.title)).toEqual(["Good"])
  })

  it("a Greenhouse job with a javascript: absolute_url is dropped", async () => {
    server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/evil/jobs", () =>
        HttpResponse.json({
          jobs: [
            { id: 1, title: "Bad", absolute_url: "javascript:alert(1)" },
            { id: 2, title: "Good", absolute_url: "https://boards.greenhouse.io/evil/jobs/2" },
          ],
        })
      )
    )
    const postings = await readEmployerBoard(boardHttp, { company: "Evil", applicationSystem: "greenhouse", boardToken: "evil" })
    expect(postings.map((posting) => posting.title)).toEqual(["Good"])
  })

  it("a Lever job with a data: applyUrl keeps its https hostedUrl as the apply link", async () => {
    server.use(
      http.get("https://api.lever.co/v0/postings/evil", () =>
        HttpResponse.json([{ id: "a", text: "Job", hostedUrl: "https://jobs.lever.co/evil/a", applyUrl: "data:text/html,x" }])
      )
    )
    const [posting] = await readEmployerBoard(boardHttp, { company: "Evil", applicationSystem: "lever", boardToken: "evil" })
    expect(posting?.applyUrl).toBe("https://jobs.lever.co/evil/a")
  })

  it.each(["&#99999999;", "&#55296;", "&#x110000;", "&#xD800;"])("an out-of-range character reference %s does not throw", (entity) => {
    expect(htmlToText(`a ${entity} b`)).toBe("a \uFFFD b")
  })

  it("a valid hex reference is decoded", () => {
    expect(decodeEntities("caf&#xE9; &#233;")).toBe("café é")
  })

  it("a bad entity in one Greenhouse job keeps the rest of the board", async () => {
    server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/ent/jobs", () =>
        HttpResponse.json({
          jobs: [
            { id: 1, title: "Odd", absolute_url: "https://boards.greenhouse.io/ent/jobs/1", content: "x &#99999999; y" },
            { id: 2, title: "Fine", absolute_url: "https://boards.greenhouse.io/ent/jobs/2", content: "ok" },
          ],
        })
      )
    )
    const postings = await readEmployerBoard(boardHttp, { company: "Ent", applicationSystem: "greenhouse", boardToken: "ent" })
    expect(postings.map((posting) => posting.title)).toEqual(["Odd", "Fine"])
  })
})

// EPIC-0006 posted-date.feature (AC-5.2): each reader hands the pipeline its source's date fields in preference order.
describe("EPIC-0006 posted date fields per source (AC-5.2)", () => {
  const READ_AT = new Date("2026-10-24T08:00:00Z")
  const dateOf = (posting: { postedDate: Parameters<typeof resolvePostedDate>[0] } | undefined) =>
    posting ? resolvePostedDate(posting.postedDate, READ_AT) : null
  const posted = (iso: string, kind: "published" | "updated" = "published") => ({ postedAt: new Date(iso), postedDateKind: kind })

  it("Greenhouse board: first_published, else updated_at as basis updated", async () => {
    server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/acme/jobs", () =>
        HttpResponse.json({
          jobs: [
            { id: 1, title: "A", absolute_url: "https://boards.greenhouse.io/acme/jobs/1", first_published: "2026-10-20T14:30:00-04:00", updated_at: "2026-10-22T10:00:00Z" },
            { id: 2, title: "B", absolute_url: "https://boards.greenhouse.io/acme/jobs/2", updated_at: "2026-10-22T10:00:00Z" },
            { id: 3, title: "C", absolute_url: "https://boards.greenhouse.io/acme/jobs/3", first_published: "garbage", updated_at: null },
          ],
        })
      )
    )
    const postings = await readEmployerBoard(boardHttp, { company: "Acme", applicationSystem: "greenhouse", boardToken: "acme" })
    expect(postings.map(dateOf)).toEqual([posted("2026-10-20T18:30:00Z"), posted("2026-10-22T10:00:00Z", "updated"), { postedAt: null, postedDateKind: null }])
  })

  it("Lever board: createdAt in epoch milliseconds", async () => {
    server.use(http.get("https://api.lever.co/v0/postings/globex", () => HttpResponse.json([{ id: "a", text: "A", hostedUrl: "https://jobs.lever.co/globex/a", createdAt: 1792497600000 }])))
    const [posting] = await readEmployerBoard(boardHttp, { company: "Globex", applicationSystem: "lever", boardToken: "globex" })
    expect(dateOf(posting)).toEqual(posted("2026-10-20T12:00:00Z"))
  })

  it("Ashby board: publishedAt; no updatedAt key means no fallback", async () => {
    server.use(
      http.get("https://api.ashbyhq.com/posting-api/job-board/umbrella", () =>
        HttpResponse.json({
          jobs: [
            { id: "a", title: "A", jobUrl: "https://jobs.ashbyhq.com/umbrella/a", publishedAt: "2026-10-20T12:00:00.000+00:00" },
            { id: "b", title: "B", jobUrl: "https://jobs.ashbyhq.com/umbrella/b", publishedAt: "garbage" },
          ],
        })
      )
    )
    const postings = await readEmployerBoard(boardHttp, { company: "Umbrella", applicationSystem: "ashby", boardToken: "umbrella" })
    expect(postings.map(dateOf)).toEqual([posted("2026-10-20T12:00:00Z"), { postedAt: null, postedDateKind: null }])
  })

  it("Himalayas: pubDate in epoch seconds; expiryDate ignored", async () => {
    server.use(
      http.get("https://himalayas.app/jobs/api", () =>
        HttpResponse.json({
          jobs: [
            { title: "A", companyName: "Co", applicationLink: "https://himalayas.app/companies/co/jobs/a", pubDate: 1792497600, expiryDate: 1795089600 },
            { title: "B", companyName: "Co", applicationLink: "https://himalayas.app/companies/co/jobs/b", expiryDate: 1795089600 },
          ],
        })
      )
    )
    const postings = await readRemoteBoard(boardHttp, "himalayas")
    expect(postings.map(dateOf)).toEqual([posted("2026-10-20T12:00:00Z"), { postedAt: null, postedDateKind: null }])
  })

  it("Remote OK: date first, epoch seconds when date is invalid", async () => {
    server.use(
      http.get("https://remoteok.com/api", () =>
        HttpResponse.json([
          { legal: "notice" },
          { id: 1, position: "A", company: "Co", url: "https://remoteok.com/remote-jobs/1", date: "2026-10-20T12:00:00+00:00", epoch: 1792584000 },
          { id: 2, position: "B", company: "Co", url: "https://remoteok.com/remote-jobs/2", date: "not a date", epoch: 1792497600 },
        ])
      )
    )
    const postings = await readRemoteBoard(boardHttp, "remoteok")
    expect(postings.map(dateOf)).toEqual([posted("2026-10-20T12:00:00Z"), posted("2026-10-20T12:00:00Z")])
  })

  it("We Work Remotely: RSS pubDate", async () => {
    server.use(
      http.get("https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss", () =>
        HttpResponse.text(
          `<rss><channel><item><title>Co: Frontend Engineer</title><link>https://weworkremotely.com/remote-jobs/co-frontend</link><pubDate>Tue, 20 Oct 2026 12:00:00 +0000</pubDate></item></channel></rss>`
        )
      )
    )
    const [posting] = await readRemoteBoard(boardHttp, "weworkremotely")
    expect(dateOf(posting)).toEqual(posted("2026-10-20T12:00:00Z"))
  })

  it("Remotive: offset-less publication_date read as UTC", async () => {
    server.use(
      http.get("https://remotive.com/api/remote-jobs", () =>
        HttpResponse.json({ jobs: [{ id: 1, url: "https://remotive.com/remote-jobs/software-dev/a-1", title: "A", company_name: "Co", publication_date: "2026-10-17T16:04:29" }] })
      )
    )
    const [posting] = await readRemoteBoard(boardHttp, "remotive")
    expect(dateOf(posting)).toEqual(posted("2026-10-17T16:04:29Z"))
  })

  it("a remote-board posting resolved through an ATS uses the board date, else the ATS fields", async () => {
    server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/globex/jobs/77", () =>
        HttpResponse.json({ id: 77, title: "A", absolute_url: "https://boards.greenhouse.io/globex/jobs/77", first_published: "2026-10-10T09:00:00Z" })
      )
    )
    const base = {
      applicationUrl: "https://remoteok.com/remote-jobs/9",
      requisitionId: "9",
      applyUrl: "https://remoteok.com/remote-jobs/9",
      title: "A",
      company: "Globex",
      text: "Apply at https://boards.greenhouse.io/globex/jobs/77",
      structured: { workplace: "remote" as const, locationRestrictions: null, pay: null, employmentType: null },
      attribution: { name: "Remote OK", url: "https://remoteok.com/remote-jobs/9" },
      manualOnly: false,
    }
    const withBoardDate = await resolveThroughAts(boardHttp, { ...base, postedDate: [epochCandidate(1792314000, "seconds", "published")] })
    expect(dateOf(withBoardDate)).toEqual(posted("2026-10-18T09:00:00Z"))
    const withoutBoardDate = await resolveThroughAts(boardHttp, { ...base, postedDate: [epochCandidate(null, "seconds", "published")] })
    expect(dateOf(withoutBoardDate)).toEqual(posted("2026-10-10T09:00:00Z"))
  })

  it("a pasted Lever link carries createdAt from its lookup", async () => {
    server.use(
      http.get("https://api.lever.co/v0/postings/globex/abc-123", () =>
        HttpResponse.json({ id: "abc-123", text: "A", hostedUrl: "https://jobs.lever.co/globex/abc-123", createdAt: 1792497600000 })
      )
    )
    const posting = await lookUpAtsPosting(boardHttp, "https://jobs.lever.co/globex/abc-123")
    expect(dateOf(posting ?? undefined)).toEqual(posted("2026-10-20T12:00:00Z"))
  })
})

describe("EPIC-0010 hasJobBody (RP:96)", () => {
  it("is false when text holds only the title and location header", () => {
    expect(hasJobBody({ title: "Engineer", text: "Engineer" })).toBe(false)
    expect(hasJobBody({ title: "Engineer", text: "Engineer\nLocation: Remote" })).toBe(false)
  })
  it("is true when a description body follows the headers", () => {
    expect(hasJobBody({ title: "Engineer", text: "Engineer\nLocation: Remote\nBuild things." })).toBe(true)
    expect(hasJobBody({ title: "Engineer", text: "Engineer\nBuild things." })).toBe(true)
  })
})
