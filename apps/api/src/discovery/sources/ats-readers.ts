import { z } from "zod"

import { normaliseApplicationUrl } from "../application-url.js"
import type { PayRange } from "../rules/pay.js"
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
import { epochCandidate, isoCandidate } from "./posted-date.js"

/** The employer board readers (architecture r1, "Why the job board APIs matter"). Public GET APIs only. */
export type EmployerBoardRef = Readonly<{ company: string; applicationSystem: "greenhouse" | "lever" | "ashby"; boardToken: string }>

export async function readEmployerBoard(http: BoardHttp, board: EmployerBoardRef): Promise<DiscoveredPosting[]> {
  const postings =
    board.applicationSystem === "greenhouse"
      ? await readGreenhouse(http, board)
      : board.applicationSystem === "lever"
        ? await readLever(http, board)
        : await readAshby(http, board)
  return onlyWebUrls(postings)
}

export function boardUrl(board: Pick<EmployerBoardRef, "applicationSystem" | "boardToken">): string {
  const token = encodeURIComponent(board.boardToken)
  if (board.applicationSystem === "greenhouse") return `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`
  if (board.applicationSystem === "lever") return `https://api.lever.co/v0/postings/${token}?mode=json`
  return `https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`
}

const greenhouseSchema = z.object({
  jobs: z.array(
    z.object({
      id: z.number(),
      title: z.string(),
      absolute_url: z.string(),
      requisition_id: z.string().nullish(),
      content: z.string().nullish(),
      location: z.object({ name: z.string().nullish() }).nullish(),
      company_name: z.string().nullish(),
      first_published: z.unknown().optional(),
      updated_at: z.unknown().optional(),
    })
  ),
})

/** Greenhouse (AC-5.2): `first_published` (published), else `updated_at` (updated); both ISO-8601. */
export function greenhouseDates(job: Readonly<{ first_published?: unknown; updated_at?: unknown }>) {
  return [isoCandidate(job.first_published, "published"), isoCandidate(job.updated_at, "updated")]
}

async function readGreenhouse(http: BoardHttp, board: EmployerBoardRef): Promise<DiscoveredPosting[]> {
  const body = parse(greenhouseSchema, await http.getJson(boardUrl(board)))
  return body.jobs.map((job) => {
    const location = job.location?.name ?? null
    return {
      applicationUrl: normaliseApplicationUrl(job.absolute_url),
      requisitionId: nonEmpty(job.requisition_id) ?? String(job.id),
      applyUrl: job.absolute_url,
      title: job.title,
      company: job.company_name ?? board.company,
      text: joinText(job.title, location ? `Location: ${location}` : null, htmlToText(decodeEntities(job.content ?? ""))),
      structured: { ...EMPTY_STRUCTURED, workplace: /remote/i.test(location ?? "") ? "remote" : null },
      attribution: null,
      manualOnly: false,
      postedDate: greenhouseDates(job),
    }
  })
}

const leverSchema = z.array(
  z.object({
    id: z.string(),
    text: z.string(),
    hostedUrl: z.string(),
    applyUrl: z.string().nullish(),
    workplaceType: z.string().nullish(),
    country: z.string().nullish(),
    descriptionPlain: z.string().nullish(),
    additionalPlain: z.string().nullish(),
    lists: z.array(z.object({ text: z.string(), content: z.string() })).nullish(),
    categories: z.object({ location: z.string().nullish(), commitment: z.string().nullish() }).nullish(),
    salaryRange: z
      .object({ currency: z.string(), interval: z.string(), min: z.number(), max: z.number() })
      .nullish(),
    createdAt: z.unknown().optional(),
  })
)

/** Lever (AC-5.2): `createdAt`, epoch milliseconds; no updated field exists. */
export function leverDates(job: Readonly<{ createdAt?: unknown }>) {
  return [epochCandidate(job.createdAt, "milliseconds", "published")]
}

async function readLever(http: BoardHttp, board: EmployerBoardRef): Promise<DiscoveredPosting[]> {
  const jobs = parse(leverSchema, await http.getJson(boardUrl(board)))
  return jobs.map((job) => {
    const lists = (job.lists ?? []).map((list) => `${list.text}\n${htmlToText(list.content)}`).join("\n")
    const location = job.categories?.location ?? null
    return {
      applicationUrl: normaliseApplicationUrl(job.hostedUrl),
      requisitionId: job.id,
      applyUrl: firstWebUrl(job.applyUrl, job.hostedUrl) ?? job.hostedUrl,
      title: job.text,
      company: board.company,
      text: joinText(job.text, location ? `Location: ${location}` : null, job.descriptionPlain ?? null, lists, job.additionalPlain ?? null),
      structured: {
        workplace: workplace(job.workplaceType),
        locationRestrictions: null,
        pay: job.salaryRange ? payFrom(job.salaryRange.currency, job.salaryRange.min, job.salaryRange.max, job.salaryRange.interval) : null,
        employmentType: employmentTypeFrom(job.categories?.commitment),
      },
      attribution: null,
      manualOnly: false,
      postedDate: leverDates(job),
    }
  })
}

const ashbySchema = z.object({
  jobs: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      jobUrl: z.string(),
      applyUrl: z.string().nullish(),
      isRemote: z.boolean().nullish(),
      workplaceType: z.string().nullish(),
      employmentType: z.string().nullish(),
      location: z.string().nullish(),
      descriptionPlain: z.string().nullish(),
      isListed: z.boolean().nullish(),
      publishedAt: z.unknown().optional(),
      updatedAt: z.unknown().optional(),
      compensation: z
        .object({
          summaryComponents: z
            .array(
              z.object({
                compensationType: z.string(),
                interval: z.string().nullish(),
                currencyCode: z.string().nullish(),
                minValue: z.number().nullish(),
                maxValue: z.number().nullish(),
              })
            )
            .nullish(),
        })
        .nullish(),
    })
  ),
})

/** Ashby (AC-5.2): `publishedAt`; an `updatedAt` is accepted if one ever appears (none observed). */
function ashbyDates(job: Readonly<{ publishedAt?: unknown; updatedAt?: unknown }>) {
  return [isoCandidate(job.publishedAt, "published"), isoCandidate(job.updatedAt, "updated")]
}

async function readAshby(http: BoardHttp, board: EmployerBoardRef): Promise<DiscoveredPosting[]> {
  const body = parse(ashbySchema, await http.getJson(boardUrl(board)))
  return body.jobs
    .filter((job) => job.isListed !== false)
    .map((job) => {
      const salary = job.compensation?.summaryComponents?.find((part) => part.compensationType === "Salary" && part.maxValue)
      return {
        applicationUrl: normaliseApplicationUrl(job.jobUrl),
        requisitionId: job.id,
        applyUrl: firstWebUrl(job.applyUrl, job.jobUrl) ?? job.jobUrl,
        title: job.title,
        company: board.company,
        text: joinText(job.title, job.location ? `Location: ${job.location}` : null, job.descriptionPlain ?? null),
        structured: {
          workplace: job.isRemote ? "remote" : workplace(job.workplaceType),
          locationRestrictions: null,
          pay:
            salary?.currencyCode && salary.maxValue
              ? payFrom(salary.currencyCode, salary.minValue ?? null, salary.maxValue, salary.interval ?? "")
              : null,
          employmentType: employmentTypeFrom(job.employmentType),
        },
        attribution: null,
        manualOnly: false,
        postedDate: ashbyDates(job),
      }
    })
}

export function payFrom(currency: string, min: number | null, max: number, interval: string): PayRange | null {
  const folded = interval.toLowerCase()
  const period = /hour/.test(folded) ? "hour" : /month/.test(folded) ? "month" : /year|annual/.test(folded) ? "year" : null
  if (period === null || !/^[A-Z]{3}$/.test(currency) || max <= 0) return null
  const range = min === null || min === max ? `${max.toLocaleString("en-US")}` : `${min.toLocaleString("en-US")}–${max.toLocaleString("en-US")}`
  return { currency, min, max, period, label: `${currency} ${range} per ${period}` }
}

function workplace(value: string | null | undefined): "remote" | "onsite" | "hybrid" | null {
  const folded = (value ?? "").toLowerCase()
  if (folded.includes("remote")) return "remote"
  if (folded.includes("hybrid")) return "hybrid"
  if (folded.includes("on-site") || folded.includes("onsite") || folded.includes("office")) return "onsite"
  return null
}

function parse<Schema extends z.ZodType>(schema: Schema, body: unknown): z.output<Schema> {
  const result = schema.safeParse(body)
  if (!result.success) throw new BoardReadError("unexpected_body")
  return result.data
}

function nonEmpty(value: string | null | undefined): string | null {
  return value && value.trim() !== "" ? value.trim() : null
}

export function joinText(...parts: ReadonlyArray<string | null>): string {
  return parts.filter((part): part is string => part !== null && part.trim() !== "").join("\n")
}
