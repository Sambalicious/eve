/**
 * EPIC-0006 recorded source fixtures (QA test authoring). Each builder returns
 * one job shaped like the fields the Architect observed in live responses on
 * 2026-10-24 (architecture.r1.md "Verified source fields", prd.r2.md AC-5.2):
 *
 * | Source            | published field                  | updated field            |
 * |-------------------|----------------------------------|--------------------------|
 * | Greenhouse board  | first_published (ISO, offset)    | updated_at (ISO, offset) |
 * | Greenhouse job    | first_published                  | updated_at               |
 * | Lever             | createdAt (epoch milliseconds)   | none                     |
 * | Ashby             | publishedAt (ISO, offset)        | none (no updatedAt key)  |
 * | Himalayas         | pubDate (epoch seconds)          | none; expiryDate ignored |
 * | Remote OK         | date (ISO), else epoch (seconds) | none                     |
 * | Remotive          | publication_date (no offset=UTC) | none                     |
 * | We Work Remotely  | RSS <pubDate> (RFC 2822)         | none                     |
 *
 * `undefined` omits the key; any other value (including null, "", objects)
 * is sent as-is, so invalid shapes reach the reader exactly as a source could
 * send them. Extra fields beyond the reader's current schema are deliberate.
 */

type Value = unknown

function withField<T extends Record<string, unknown>>(base: T, fields: Record<string, Value>): T {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value
  return out as T
}

export function greenhouseJob(id: number, title: string, dates: { first_published?: Value; updated_at?: Value } = {}, board = "canonical") {
  return withField(
    {
      id,
      title,
      absolute_url: `https://boards.greenhouse.io/${board}/jobs/${id}`,
      requisition_id: `GH-${id}`,
      content: "Remote, open to candidates in Nigeria. Build React features.",
      location: { name: "Remote" },
      internal_job_id: id + 1,
      metadata: null,
      company_name: board === "canonical" ? "Canonical" : board,
    },
    dates
  )
}

export function leverJob(id: string, title: string, createdAt?: Value, board = "metabase") {
  return withField(
    {
      id,
      text: title,
      hostedUrl: `https://jobs.lever.co/${board}/${id}`,
      applyUrl: `https://jobs.lever.co/${board}/${id}/apply`,
      descriptionPlain: "Remote, open to candidates in Nigeria. Build React features.",
      categories: { location: "Remote", commitment: "Full-time" },
      workplaceType: "remote",
    },
    { createdAt }
  )
}

/** Ashby sends no updatedAt key on any job (P12). */
export function ashbyJob(id: string, title: string, publishedAt?: Value, board = "railway") {
  return withField(
    {
      id,
      title,
      jobUrl: `https://jobs.ashbyhq.com/${board}/${id}`,
      applyUrl: `https://jobs.ashbyhq.com/${board}/${id}/application`,
      isRemote: true,
      isListed: true,
      employmentType: "FullTime",
      location: "Remote",
      descriptionPlain: "Remote, open to candidates in Nigeria. Build React features.",
    },
    { publishedAt }
  )
}

export function himalayasJob(guid: string, title: string, dates: { pubDate?: Value; expiryDate?: Value } = {}, applicationLink = `https://himalayas.app/companies/acme/jobs/${guid}`) {
  return withField(
    {
      title,
      companyName: "Acme",
      applicationLink,
      guid,
      locationRestrictions: [],
      employmentType: "Full Time",
      description: "Remote worldwide. Build React features.",
      excerpt: "Build React features.",
    },
    dates
  )
}

export function remoteOkJob(id: string, position: string, dates: { date?: Value; epoch?: Value } = {}, description = "Remote worldwide. Build React features.") {
  return withField(
    {
      slug: `remote-${id}`,
      id,
      position,
      company: "Umbrella",
      url: `https://remoteok.com/remote-jobs/${id}`,
      apply_url: `https://remoteok.com/remote-jobs/${id}`,
      location: "Worldwide",
      description,
    },
    dates
  )
}

/** Remote OK's first array element is its legal notice. */
export const REMOTE_OK_LEGAL = { legal: "API Terms of Service: link back to Remote OK and mention it as the source." }

export function remotiveJob(id: number, title: string, publication_date?: Value, description = "Build React features.") {
  return withField(
    {
      id,
      url: `https://remotive.com/remote-jobs/software-dev/${id}`,
      title,
      company_name: "Initech",
      candidate_required_location: "Worldwide",
      job_type: "full_time",
      description,
    },
    { publication_date }
  )
}

/** One We Work Remotely RSS item; `pubDate` omitted when undefined. */
export function wwrItem(slug: string, title: string, pubDate?: string, description = "Build React features.") {
  const date = pubDate === undefined ? "" : `<pubDate>${pubDate}</pubDate>`
  return `<item><title>Acme: ${title}</title><region>Anywhere in the World</region><type>Full-Time</type><link>https://weworkremotely.com/remote-jobs/${slug}</link><guid>https://weworkremotely.com/remote-jobs/${slug}</guid>${date}<description><![CDATA[${description}]]></description></item>`
}

export function wwrFeed(items: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>We Work Remotely</title>${items.join("")}</channel></rss>`
}
