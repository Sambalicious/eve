/**
 * EPIC-0007 fixtures: the ATS public API answers the stack server returns
 * instead of the live Greenhouse, Lever and Ashby APIs (AC 10.5). The URLs are
 * the ones the api builds in apps/api/src/discovery/sources/ats-lookup.ts and
 * ats-readers.ts.
 *
 * Repair wave 1 (QA-P1-T-07, check-this-job.feature r3, owner decision D10):
 * EPIC-0006 hides an undated, off-target, entry-level or > 60-day-old posting.
 * The three "visible posting" fixtures therefore carry a posted date 2 days
 * before the api started (the api runs on the real clock, so dates are relative),
 * a Frontend title and no entry-level marker. HIDDEN_CASES are the r3 CTJ:92
 * Outline rows: one link per hidden reason, each with its own stub.
 */

const DAY_MS = 86_400_000
/** 2 days ago: inside the 60-day window for any test run that starts within 58 days of the stub loading. */
export const RECENT_ISO = new Date(Date.now() - 2 * DAY_MS).toISOString()
/** 90 days ago: older than 60 days. */
export const OLD_ISO = new Date(Date.now() - 90 * DAY_MS).toISOString()

export const GREENHOUSE_JOB_URL = "https://boards.greenhouse.io/acme/jobs/4012345"
export const LEVER_JOB_URL = "https://jobs.lever.co/acme/7f3c2a10-1111-2222-3333-444455556666"
export const ASHBY_JOB_URL = "https://jobs.ashbyhq.com/beta/0a1b2c3d-0000-1111-2222-333344445555"

/** Exact API URLs per fixture, matched without the query string. */
export const ATS_API = {
  greenhouse: "https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345",
  lever: "https://api.lever.co/v0/postings/acme/7f3c2a10-1111-2222-3333-444455556666",
  ashby: "https://api.ashbyhq.com/posting-api/job-board/beta",
}

/** Visible: dated, Frontend, mid-or-higher ("Senior"). */
export const GREENHOUSE_JOB = {
  id: 4012345,
  title: "Senior Frontend Engineer",
  absolute_url: GREENHOUSE_JOB_URL,
  requisition_id: "4012345",
  company_name: "Acme",
  location: { name: "Remote" },
  content: "&lt;p&gt;Remote. Build React features. Salary USD 60,000 to 80,000 per year.&lt;/p&gt;",
  first_published: RECENT_ISO,
}

/** Visible: dated (epoch ms), Frontend, no seniority marker. */
export const LEVER_JOB = {
  id: "7f3c2a10-1111-2222-3333-444455556666",
  text: "Frontend Engineer",
  hostedUrl: LEVER_JOB_URL,
  descriptionPlain: "Remote. Build React features.",
  createdAt: Date.now() - 2 * DAY_MS,
}

/**
 * Hidden-result rows (check-this-job.feature r3 CTJ:92). `api` is the stub URL,
 * `body` the stub answer. Lever links answer one job; the Ashby row is a second
 * job on the "beta" board (see ASHBY_BOARD).
 */
export const HIDDEN_CASES = [
  {
    link: "https://jobs.lever.co/acme/fe-undated-1",
    api: "https://api.lever.co/v0/postings/acme/fe-undated-1",
    body: { id: "fe-undated-1", text: "Senior Frontend Engineer", hostedUrl: "https://jobs.lever.co/acme/fe-undated-1", descriptionPlain: "Remote." },
    reason: "no posted date",
  },
  {
    link: "https://boards.greenhouse.io/acme/jobs/4019001",
    api: "https://boards-api.greenhouse.io/v1/boards/acme/jobs/4019001",
    body: { id: 4019001, title: "Senior Data Engineer", absolute_url: "https://boards.greenhouse.io/acme/jobs/4019001", requisition_id: "4019001", company_name: "Acme", content: "Remote.", first_published: RECENT_ISO },
    reason: "off-target role",
  },
  {
    link: "https://jobs.ashbyhq.com/beta/0a1b2c3d-0000-1111-2222-333344440001",
    api: null,
    body: null,
    reason: "entry-level role",
  },
  {
    link: "https://jobs.lever.co/acme/fe-old-1",
    api: "https://api.lever.co/v0/postings/acme/fe-old-1",
    body: { id: "fe-old-1", text: "Senior Frontend Engineer", hostedUrl: "https://jobs.lever.co/acme/fe-old-1", descriptionPlain: "Remote.", createdAt: Date.now() - 90 * DAY_MS },
    reason: "posted more than 60 days ago",
  },
  {
    link: "https://jobs.lever.co/acme/data-undated-1",
    api: "https://api.lever.co/v0/postings/acme/data-undated-1",
    body: { id: "data-undated-1", text: "Senior Data Engineer", hostedUrl: "https://jobs.lever.co/acme/data-undated-1", descriptionPlain: "Remote." },
    reason: "off-target role",
  },
]

export const ASHBY_BOARD = {
  jobs: [
    {
      id: "0a1b2c3d-0000-1111-2222-333344445555",
      title: "Senior Frontend Engineer",
      jobUrl: ASHBY_JOB_URL,
      isListed: true,
      location: "Remote",
      descriptionPlain: "Remote. Build the frontend.",
      publishedAt: RECENT_ISO,
    },
    {
      // HIDDEN_CASES row 3: dated, Frontend, entry-level.
      id: "0a1b2c3d-0000-1111-2222-333344440001",
      title: "Junior Frontend Developer",
      jobUrl: "https://jobs.ashbyhq.com/beta/0a1b2c3d-0000-1111-2222-333344440001",
      isListed: true,
      location: "Remote",
      descriptionPlain: "Remote.",
      publishedAt: RECENT_ISO,
    },
  ],
}
