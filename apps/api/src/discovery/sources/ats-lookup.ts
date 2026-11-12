import { z } from "zod"

import { type AtsLocator, locateAts, normaliseApplicationUrl } from "../application-url.js"
import { type BoardHttp, BoardReadError } from "./board-http.js"
import {
  type DiscoveredPosting,
  EMPTY_STRUCTURED,
  decodeEntities,
  employmentTypeFrom,
  firstWebUrl,
  htmlToText,
  onlyWebUrls,
} from "./discovered-posting.js"
import { greenhouseDates, joinText, leverDates, payFrom, readEmployerBoard } from "./ats-readers.js"

/**
 * Resolves a Greenhouse, Lever or Ashby posting URL through that system's public
 * API (never the job page). Used for pasted links and for the ATS link inside a
 * Remote OK or We Work Remotely posting. Returns null when the API doesn't know
 * the posting (closed, wrong board, or not a posting URL).
 */
export async function lookUpAtsPosting(http: BoardHttp, url: string): Promise<DiscoveredPosting | null> {
  const locator = locateAts(url)
  if (!locator) return null
  try {
    const posting =
      locator.system === "greenhouse"
        ? await greenhouseJob(http, locator)
        : locator.system === "lever"
          ? await leverJob(http, locator)
          : await ashbyJob(http, locator)
    return posting && onlyWebUrls([posting]).length === 1 ? posting : null
  } catch (error) {
    if (error instanceof BoardReadError && error.reason === "http_status" && error.status === 404) return null
    throw error
  }
}

/**
 * EPIC-0010 (RP:96): whether a looked-up posting carries a job description body. `text` always starts with the
 * title and an optional `Location:` line, so those headers are dropped before judging; an empty description with
 * only a title is "no job content".
 */
export function hasJobBody(posting: Pick<DiscoveredPosting, "title" | "text">): boolean {
  const lines = posting.text.split("\n")
  if (lines[0]?.trim() === posting.title.trim()) lines.shift()
  if (lines[0]?.startsWith("Location: ")) lines.shift()
  return lines.join("\n").trim() !== ""
}

/** The first Greenhouse, Lever or Ashby posting URL in `text`, or null. */
export function findAtsUrl(text: string): string | null {
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
    const candidate = match[0].replace(/[.,;]+$/, "")
    if (locateAts(candidate)) return candidate
  }
  return null
}

const greenhouseJobSchema = z.object({
  id: z.number(),
  title: z.string(),
  absolute_url: z.string(),
  requisition_id: z.string().nullish(),
  content: z.string().nullish(),
  location: z.object({ name: z.string().nullish() }).nullish(),
  company_name: z.string().nullish(),
  pay_input_ranges: z
    .array(z.object({ min_cents: z.number(), max_cents: z.number(), currency_type: z.string() }))
    .nullish(),
  first_published: z.unknown().optional(),
  updated_at: z.unknown().optional(),
})

async function greenhouseJob(http: BoardHttp, locator: AtsLocator): Promise<DiscoveredPosting> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(locator.board)}/jobs/${encodeURIComponent(locator.jobId)}?pay_transparency=true`
  const result = greenhouseJobSchema.safeParse(await http.getJson(url))
  if (!result.success) throw new BoardReadError("unexpected_body")
  const job = result.data
  const location = job.location?.name ?? null
  const range = job.pay_input_ranges?.[0]
  return {
    applicationUrl: normaliseApplicationUrl(job.absolute_url),
    requisitionId: job.requisition_id?.trim() || String(job.id),
    applyUrl: job.absolute_url,
    title: job.title,
    company: job.company_name ?? locator.board,
    text: joinText(job.title, location ? `Location: ${location}` : null, htmlToText(decodeEntities(job.content ?? ""))),
    structured: {
      ...EMPTY_STRUCTURED,
      workplace: /remote/i.test(location ?? "") ? "remote" : null,
      // Greenhouse pay transparency ranges are annual salaries.
      pay: range ? payFrom(range.currency_type, range.min_cents / 100, range.max_cents / 100, "year") : null,
    },
    attribution: null,
    manualOnly: false,
    postedDate: greenhouseDates(job),
  }
}

const leverJobSchema = z.object({
  id: z.string(),
  text: z.string(),
  hostedUrl: z.string(),
  applyUrl: z.string().nullish(),
  workplaceType: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  additionalPlain: z.string().nullish(),
  lists: z.array(z.object({ text: z.string(), content: z.string() })).nullish(),
  categories: z.object({ location: z.string().nullish(), commitment: z.string().nullish() }).nullish(),
  salaryRange: z.object({ currency: z.string(), interval: z.string(), min: z.number(), max: z.number() }).nullish(),
  createdAt: z.unknown().optional(),
})

async function leverJob(http: BoardHttp, locator: AtsLocator): Promise<DiscoveredPosting> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(locator.board)}/${encodeURIComponent(locator.jobId)}?mode=json`
  const result = leverJobSchema.safeParse(await http.getJson(url))
  if (!result.success) throw new BoardReadError("unexpected_body")
  const job = result.data
  const lists = (job.lists ?? []).map((list) => `${list.text}\n${htmlToText(list.content)}`).join("\n")
  const location = job.categories?.location ?? null
  return {
    applicationUrl: normaliseApplicationUrl(job.hostedUrl),
    requisitionId: job.id,
    applyUrl: firstWebUrl(job.applyUrl, job.hostedUrl) ?? job.hostedUrl,
    title: job.text,
    company: locator.board,
    text: joinText(job.text, location ? `Location: ${location}` : null, job.descriptionPlain ?? null, lists, job.additionalPlain ?? null),
    structured: {
      workplace: /remote/i.test(job.workplaceType ?? "") ? "remote" : null,
      locationRestrictions: null,
      pay: job.salaryRange ? payFrom(job.salaryRange.currency, job.salaryRange.min, job.salaryRange.max, job.salaryRange.interval) : null,
      employmentType: employmentTypeFrom(job.categories?.commitment),
    },
    attribution: null,
    manualOnly: false,
    postedDate: leverDates(job),
  }
}

/** Ashby has no single-posting endpoint in its public API, so the board list is read and the posting found in it. */
async function ashbyJob(http: BoardHttp, locator: AtsLocator): Promise<DiscoveredPosting | null> {
  const postings = await readEmployerBoard(http, { company: locator.board, applicationSystem: "ashby", boardToken: locator.board })
  return postings.find((posting) => posting.requisitionId === locator.jobId) ?? null
}
