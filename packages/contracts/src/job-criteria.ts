import { z } from "zod"

import { DEFAULT_SENIORITY_FLOOR, DEFAULT_TARGET_ROLE_FAMILIES, type RoleFamilyValue, roleFamilySchema, seniorityFloorSchema } from "./discovery.js"
import { normaliseTechnologyName } from "./technology-names.js"

/**
 * v1.13.0 (EPIC-0004): the Candidate's Job criteria. `GET` and `PUT`; the PUT
 * needs the CSRF header. No version precondition: the last successful save
 * wins (AC 1.4). `version` is read-only and increments on every save (AC 5.7).
 */
export const JOB_CRITERIA_PATH = "/v1/candidate-settings/job-criteria"

/** AC 3.1, checked after trimming: Unicode letters, ASCII digits, U+0020 space and `. + # - / _`. */
export const JOB_CRITERIA_ENTRY_PATTERN = /^[\p{L}0-9 .+#\-/_]+$/u
export const JOB_CRITERIA_ENTRY_MAX_LENGTH = 40
export const JOB_CRITERIA_LIST_MAX_ENTRIES = 20
/** The migrated and default criteria (AC 1.2, 2.1, 6.3; v1.18.0 adds the target families and the seniority floor). */
export const DEFAULT_JOB_CRITERIA = Object.freeze({
  minCoreMatchPercent: 70,
  frameworks: [],
  technologies: [],
  targetRoleFamilies: DEFAULT_TARGET_ROLE_FAMILIES,
  seniorityFloor: DEFAULT_SENIORITY_FLOOR,
})
/** v1.18.0: at most one entry per family. */
export const TARGET_ROLE_FAMILIES_MAX_ENTRIES = 13

export const jobCriteriaListNames = ["frameworks", "technologies"] as const
export type JobCriteriaListName = (typeof jobCriteriaListNames)[number]

/**
 * AC 3.1 plus decision O3 (CR-01), for a trimmed entry: only allowed
 * characters, and at least one letter or digit left after normalisation. So
 * ".", "-" and "_" are refused: they normalise to "", which no posting can
 * match. Both refusals are `entry_disallowed_characters`.
 */
export function isAllowedJobCriteriaEntry(trimmed: string): boolean {
  return JOB_CRITERIA_ENTRY_PATTERN.test(trimmed) && /[\p{L}\p{N}]/u.test(normaliseTechnologyName(trimmed))
}

const entry = z
  .string()
  .trim()
  .min(1)
  .max(JOB_CRITERIA_ENTRY_MAX_LENGTH)
  .superRefine((value, ctx) => {
    if (value === "" || isAllowedJobCriteriaEntry(value)) return
    ctx.addIssue({ code: "invalid_format", format: "regex", pattern: JOB_CRITERIA_ENTRY_PATTERN.source, message: "entry_disallowed_characters", input: value })
  })
const list = z.array(entry).max(JOB_CRITERIA_LIST_MAX_ENTRIES)

export type DuplicateEntry = Readonly<{ list: JobCriteriaListName; /** 1-based position of the later entry. */ position: number }>

/**
 * AC 3.3 / 3.7: the later of two entries with equal normalised forms, within
 * one list or across both. Frameworks come before technologies. Entries that
 * are not strings are ignored here (they fail their own check). An empty
 * normalised form counts like any other, as api-contract.r2 states.
 */
export function findDuplicateEntries(lists: Readonly<Record<JobCriteriaListName, unknown>>): DuplicateEntry[] {
  const seen = new Set<string>()
  const duplicates: DuplicateEntry[] = []
  for (const name of jobCriteriaListNames) {
    const entries = lists[name]
    if (!Array.isArray(entries)) continue
    entries.forEach((value: unknown, index) => {
      if (typeof value !== "string") return
      const normalised = normaliseTechnologyName(value)
      if (seen.has(normalised)) duplicates.push({ list: name, position: index + 1 })
      else seen.add(normalised)
    })
  }
  return duplicates
}

/**
 * v1.18.0 (AC-1.5, AC-1.9): 1 to 13 entries, each an exact role family key,
 * each at most once. Whole-field problems (not an array, empty, too many) give
 * no per-entry issue. Parses to the families in catalog order.
 */
const targetRoleFamilies = z
  .array(z.unknown())
  .min(1)
  .max(TARGET_ROLE_FAMILIES_MAX_ENTRIES)
  .superRefine((entries, ctx) => {
    if (entries.length === 0 || entries.length > TARGET_ROLE_FAMILIES_MAX_ENTRIES) return
    const seen = new Set<string>()
    entries.forEach((entry, index) => {
      if (typeof entry !== "string") ctx.addIssue({ code: "custom", message: "invalid", path: [index], input: entry })
      else if (!roleFamilySchema.safeParse(entry).success) ctx.addIssue({ code: "custom", message: "unknown_entry", path: [index], input: entry })
      else if (seen.has(entry)) ctx.addIssue({ code: "custom", message: "duplicate_entry", path: [index], input: entry })
      else seen.add(entry)
    })
  })
  .transform((entries): RoleFamilyValue[] => roleFamilySchema.options.filter((family) => entries.includes(family)))

export const jobCriteriaRequestSchema = z
  .object({
    minCoreMatchPercent: z.int().min(1).max(100),
    frameworks: list,
    technologies: list,
    targetRoleFamilies,
    seniorityFloor: seniorityFloorSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const duplicate of findDuplicateEntries(value)) {
      ctx.addIssue({ code: "custom", message: "duplicate_entry", path: [duplicate.list, duplicate.position - 1] })
    }
  })
export type JobCriteriaRequest = z.infer<typeof jobCriteriaRequestSchema>

export const jobCriteriaResponseSchema = z
  .object({
    minCoreMatchPercent: z.int().min(1).max(100),
    /** Trimmed, as typed, in the order saved. */
    frameworks: z.array(z.string()),
    technologies: z.array(z.string()),
    /** v1.18.0: the session Candidate's targets, unique, catalog order. */
    targetRoleFamilies: z.array(roleFamilySchema).min(1).max(TARGET_ROLE_FAMILIES_MAX_ENTRIES),
    /** v1.18.0. */
    seniorityFloor: seniorityFloorSchema,
    /** Read-only criteria version (AC 5.7). Every successful save adds 1. */
    version: z.int().positive(),
  })
  .strict()
export type JobCriteriaResponse = z.infer<typeof jobCriteriaResponseSchema>

export const jobCriteriaFieldSchema = z.enum(["minCoreMatchPercent", "frameworks", "technologies", "targetRoleFamilies", "seniorityFloor"])
export const jobCriteriaFieldProblemSchema = z.enum([
  "invalid",
  "too_many_entries",
  "entry_empty",
  "entry_too_long",
  "entry_disallowed_characters",
  "duplicate_entry",
  // v1.18.0
  "too_few_entries",
  "unknown_entry",
])

/** One field-level error on `400 bad_request` from `PUT /v1/candidate-settings/job-criteria`. */
export const fieldErrorSchema = z
  .object({
    field: jobCriteriaFieldSchema,
    /** 1-based list position; null means the whole field. */
    position: z.int().positive().nullable(),
    problem: jobCriteriaFieldProblemSchema,
  })
  .strict()
export type FieldError = z.infer<typeof fieldErrorSchema>

type ZodIssue = z.core.$ZodIssue

/**
 * Maps Zod issues from `jobCriteriaRequestSchema` to the contract's
 * `fieldErrors` (architecture "Field-level errors"). Returns an empty list when
 * the problem cannot be named by field: a body that is not an object, or an
 * unknown key (`baseVersion` included), gets a plain `bad_request`. Values are
 * never echoed. One error per field and position: the first problem found.
 * The API and the web MSW fake both call this one function (F3, CR-07).
 */
export function jobCriteriaFieldErrors(body: unknown, issues: readonly ZodIssue[]): FieldError[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return []
  if (issues.some((issue) => issue.code === "unrecognized_keys" || issue.path.length === 0)) return []
  const errors: FieldError[] = []
  const seen = new Set<string>()
  for (const issue of issues) {
    const error = toFieldError(issue)
    if (!error) return []
    const key = `${error.field}:${error.position ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    errors.push(error)
  }
  return errors
}

function toFieldError(issue: ZodIssue): FieldError | null {
  const [head, index] = issue.path
  const field = jobCriteriaFieldSchema.safeParse(head)
  if (!field.success) return null
  if (field.data === "minCoreMatchPercent" || field.data === "seniorityFloor") return { field: field.data, position: null, problem: "invalid" }
  if (index === undefined) return { field: field.data, position: null, problem: wholeListProblem(issue) }
  if (typeof index !== "number") return null
  return { field: field.data, position: index + 1, problem: entryProblem(issue) }
}

function wholeListProblem(issue: ZodIssue): FieldError["problem"] {
  if (issue.code === "too_big") return "too_many_entries"
  // Only the target families have a minimum (v1.18.0); the lists may be empty.
  if (issue.code === "too_small") return "too_few_entries"
  return "invalid"
}

function entryProblem(issue: ZodIssue): FieldError["problem"] {
  switch (issue.code) {
    case "too_small":
      return "entry_empty"
    case "too_big":
      return "entry_too_long"
    case "invalid_format":
      return "entry_disallowed_characters"
    case "custom":
      if (issue.message === "duplicate_entry") return "duplicate_entry"
      return issue.message === "unknown_entry" ? "unknown_entry" : "invalid"
    default:
      return "invalid"
  }
}
