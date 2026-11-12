import { z } from "zod"

import { locateAts, normaliseApplicationUrl } from "../application-url.js"
import type { RemoteBoardKey } from "../../db/schema.js"
import { type BoardHttp, BoardReadError } from "./board-http.js"
import { lookUpAtsPosting, findAtsUrl } from "./ats-lookup.js"
import { payFrom } from "./ats-readers.js"
import { type DiscoveredPosting, EMPTY_STRUCTURED, decodeEntities, employmentTypeFrom, htmlToText, onlyWebUrls } from "./discovered-posting.js"
import { epochCandidate, isoCandidate, rfc822Candidate } from "./posted-date.js"

/**
 * Remote-board adapters (scope "Orchestrator decisions", 2026-10-19). Each reads
 * the board's official API or feed only; board job pages are never fetched.
 *
 * - Himalayas: always a Manual Application that opens the API's applicationLink,
 *   with "via Himalayas" credit. The ATS link is never swapped in (terms 113(a)).
 * - Remote OK and We Work Remotely: automatic only when the posting's own text
 *   carries a Greenhouse, Lever or Ashby URL that the ATS API resolves to a known
 *   posting; that posting is then stored under its ATS requisition key.
 *   Otherwise a Manual Application on the board's page, with credit.
 * - Remotive: built, but never read unless the board row is available and
 *   enabled, which the database refuses until the Candidate has written permission.
 */
export const REMOTE_BOARD_URLS: Readonly<Record<RemoteBoardKey, string>> = {
  himalayas: "https://himalayas.app/jobs/api?limit=20",
  remoteok: "https://remoteok.com/api",
  weworkremotely: "https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss",
  remotive: "https://remotive.com/api/remote-jobs?category=software-dev&limit=100",
}

export type Attribution = Readonly<{ name: string; url: string }>

export async function readRemoteBoard(http: BoardHttp, key: RemoteBoardKey): Promise<DiscoveredPosting[]> {
  const read = { himalayas: readHimalayas, remoteok: readRemoteOk, weworkremotely: readWeWorkRemotely, remotive: readRemotive }[key]
  return onlyWebUrls(await read(http))
}

const himalayasSchema = z.object({
  jobs: z.array(
    z.object({
      title: z.string(),
      companyName: z.string(),
      applicationLink: z.string(),
      guid: z.string().nullish(),
      locationRestrictions: z.array(z.string()).nullish(),
      minSalary: z.number().nullish(),
      maxSalary: z.number().nullish(),
      currency: z.string().nullish(),
      salaryPeriod: z.string().nullish(),
      employmentType: z.string().nullish(),
      description: z.string().nullish(),
      excerpt: z.string().nullish(),
      // AC-5.2: epoch seconds. `expiryDate` is ignored.
      pubDate: z.unknown().optional(),
    })
  ),
})

async function readHimalayas(http: BoardHttp): Promise<DiscoveredPosting[]> {
  const body = himalayasSchema.safeParse(await http.getJson(REMOTE_BOARD_URLS.himalayas))
  if (!body.success) throw new BoardReadError("unexpected_body")
  return body.data.jobs.map((job) => ({
    applicationUrl: normaliseApplicationUrl(job.applicationLink),
    requisitionId: job.guid ?? normaliseApplicationUrl(job.applicationLink),
    // Terms 113(a): Apply always starts from applicationLink, exactly as supplied.
    applyUrl: job.applicationLink,
    title: job.title,
    company: job.companyName,
    text: [job.title, htmlToText(job.description ?? job.excerpt ?? "")].join("\n"),
    structured: {
      workplace: "remote",
      locationRestrictions: job.locationRestrictions ?? null,
      pay:
        job.maxSalary && job.currency
          ? payFrom(job.currency, job.minSalary ?? null, job.maxSalary, job.salaryPeriod ?? "year")
          : null,
      employmentType: employmentTypeFrom(job.employmentType),
    },
    attribution: { name: "Himalayas", url: job.applicationLink },
    manualOnly: true,
    postedDate: [epochCandidate(job.pubDate, "seconds", "published")],
  }))
}

const remoteOkSchema = z.array(z.record(z.string(), z.unknown()))
const remoteOkJobSchema = z.object({
  id: z.union([z.string(), z.number()]),
  position: z.string(),
  company: z.string(),
  url: z.string(),
  apply_url: z.string().nullish(),
  location: z.string().nullish(),
  salary_min: z.number().nullish(),
  salary_max: z.number().nullish(),
  description: z.string().nullish(),
  // AC-5.2: `date` (ISO-8601) first, then `epoch` (seconds).
  date: z.unknown().optional(),
  epoch: z.unknown().optional(),
})

async function readRemoteOk(http: BoardHttp): Promise<DiscoveredPosting[]> {
  const body = remoteOkSchema.safeParse(await http.getJson(REMOTE_BOARD_URLS.remoteok))
  if (!body.success) throw new BoardReadError("unexpected_body")
  const postings: DiscoveredPosting[] = []
  // The first element is the legal notice; it has no `position`.
  for (const raw of body.data) {
    const job = remoteOkJobSchema.safeParse(raw)
    if (!job.success) continue
    const text = [job.data.position, job.data.location ? `Location: ${job.data.location}` : "", htmlToText(decodeEntities(job.data.description ?? ""))]
      .filter(Boolean)
      .join("\n")
    postings.push({
      applicationUrl: normaliseApplicationUrl(job.data.url),
      requisitionId: String(job.data.id),
      applyUrl: job.data.url,
      title: job.data.position,
      company: job.data.company,
      text,
      structured: {
        ...EMPTY_STRUCTURED,
        workplace: "remote",
        pay: job.data.salary_max ? payFrom("USD", job.data.salary_min || null, job.data.salary_max, "year") : null,
      },
      attribution: { name: "Remote OK", url: job.data.url },
      manualOnly: false,
      postedDate: [isoCandidate(job.data.date, "published"), epochCandidate(job.data.epoch, "seconds", "published")],
    })
  }
  return postings
}

async function readWeWorkRemotely(http: BoardHttp): Promise<DiscoveredPosting[]> {
  const xml = await http.getText(REMOTE_BOARD_URLS.weworkremotely)
  return rssItems(xml).flatMap((item) => {
    const link = item.link
    if (!link || !item.title) return []
    const [company, ...rest] = item.title.split(":")
    const title = rest.length > 0 ? rest.join(":").trim() : item.title
    const description = htmlToText(item.description ?? "")
    return [
      {
        applicationUrl: normaliseApplicationUrl(link),
        requisitionId: item.guid ?? normaliseApplicationUrl(link),
        applyUrl: link,
        title,
        company: rest.length > 0 ? (company ?? "").trim() : "",
        text: [title, item.region ? `Region: ${item.region}` : "", description].filter(Boolean).join("\n"),
        structured: {
          ...EMPTY_STRUCTURED,
          workplace: "remote",
          employmentType: employmentTypeFrom(item.type),
        },
        attribution: { name: "We Work Remotely", url: link },
        manualOnly: false,
        postedDate: [rfc822Candidate(item.pubDate, "published")],
      },
    ]
  })
}

const remotiveSchema = z.object({
  jobs: z.array(
    z.object({
      id: z.number(),
      url: z.string(),
      title: z.string(),
      company_name: z.string(),
      candidate_required_location: z.string().nullish(),
      job_type: z.string().nullish(),
      description: z.string().nullish(),
      // AC-5.2: ISO-8601 with no offset, read as UTC.
      publication_date: z.unknown().optional(),
    })
  ),
})

async function readRemotive(http: BoardHttp): Promise<DiscoveredPosting[]> {
  const body = remotiveSchema.safeParse(await http.getJson(REMOTE_BOARD_URLS.remotive))
  if (!body.success) throw new BoardReadError("unexpected_body")
  return body.data.jobs.map((job) => ({
    applicationUrl: normaliseApplicationUrl(job.url),
    requisitionId: String(job.id),
    applyUrl: job.url,
    title: job.title,
    company: job.company_name,
    text: [job.title, job.candidate_required_location ? `Location: ${job.candidate_required_location}` : "", htmlToText(job.description ?? "")]
      .filter(Boolean)
      .join("\n"),
    structured: { ...EMPTY_STRUCTURED, workplace: "remote", employmentType: employmentTypeFrom(job.job_type) },
    attribution: { name: "Remotive", url: job.url },
    manualOnly: false,
    postedDate: [isoCandidate(job.publication_date, "published")],
  }))
}

/**
 * Remote OK, We Work Remotely and Remotive: when the posting text carries an
 * ATS URL that the ATS API resolves, use the ATS posting (its requisition key,
 * automatic) and keep the board credit. Otherwise keep the board posting, which
 * the pipeline treats as a Manual Application. Himalayas is never resolved.
 */
export async function resolveThroughAts(http: BoardHttp, posting: DiscoveredPosting): Promise<DiscoveredPosting> {
  if (posting.manualOnly) return posting
  const atsUrl = findAtsUrl(posting.text)
  if (!atsUrl || !locateAts(atsUrl)) return posting
  const resolved = await lookUpAtsPosting(http, atsUrl).catch(() => null)
  if (!resolved) return posting
  // AC-5.2: the board's date when it has a valid one, else the ATS posting's fields (bounded in that order by the pipeline).
  return { ...resolved, attribution: posting.attribution, postedDate: [...posting.postedDate, ...resolved.postedDate] }
}

type RssItem = { title?: string; link?: string; guid?: string; description?: string; region?: string; type?: string; pubDate?: string }

/** A minimal RSS 2.0 item reader for the WWR feed. Values are untrusted text. */
export function rssItems(xml: string): RssItem[] {
  const items: RssItem[] = []
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const body = match[1] ?? ""
    const field = (name: string): string | undefined => {
      const found = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`).exec(body)
      if (!found) return undefined
      const value = (found[1] ?? "").replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim()
      return decodeEntities(value)
    }
    items.push({ title: field("title"), link: field("link"), guid: field("guid"), description: field("description"), region: field("region"), type: field("type"), pubDate: field("pubDate") })
  }
  return items
}
