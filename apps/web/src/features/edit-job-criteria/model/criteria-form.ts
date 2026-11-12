import {
  JOB_CRITERIA_ENTRY_MAX_LENGTH,
  JOB_CRITERIA_LIST_MAX_ENTRIES,
  isAllowedJobCriteriaEntry,
  normaliseTechnologyName,
  type FieldError,
} from "@eve/contracts"

import type { JobCriteriaListName } from "@/entities/candidate-settings"
import { jobCriteriaCopy } from "./copy"

export type Lists = Readonly<Record<JobCriteriaListName, readonly string[]>>

export const LIST_NAMES: readonly JobCriteriaListName[] = ["frameworks", "technologies"]

/**
 * AC 2.2: trimmed, digits only, value 1 to 100. "070" is 70; "70.0", "+70",
 * "1e2" and "7 0" are refused, so the browser never decides what a number is.
 */
export function parseMinCoreMatch(text: string): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = text.trim()
  if (!/^[0-9]+$/.test(trimmed)) return { ok: false, error: jobCriteriaCopy.matchError }
  const value = Number(trimmed)
  return value >= 1 && value <= 100 ? { ok: true, value } : { ok: false, error: jobCriteriaCopy.matchError }
}

/**
 * AC 3.1 to 3.3, checked when an entry is added, in the design-spec order:
 * empty, full, too long, characters (AC 3.1 plus O3: a letter or digit must
 * survive normalising, so "." and "-" are refused), duplicate in either list after the shared
 * normaliser and alias table (`@eve/contracts`, the same code the API runs).
 */
export function checkNewEntry(
  raw: string,
  list: JobCriteriaListName,
  lists: Lists
): { ok: true; entry: string } | { ok: false; error: string } {
  const entry = raw.trim()
  const errors = jobCriteriaCopy.entryError
  if (entry === "") return { ok: false, error: errors.empty }
  if (lists[list].length >= JOB_CRITERIA_LIST_MAX_ENTRIES) return { ok: false, error: errors.full }
  if (entry.length > JOB_CRITERIA_ENTRY_MAX_LENGTH) return { ok: false, error: errors.long }
  if (!isAllowedJobCriteriaEntry(entry)) return { ok: false, error: errors.chars }
  const normalised = normaliseTechnologyName(entry)
  const taken = LIST_NAMES.some((name) => lists[name].some((existing) => normaliseTechnologyName(existing) === normalised))
  if (taken) return { ok: false, error: errors.duplicate }
  return { ok: true, entry }
}

/** AC-1.5: at least one family must be chosen before a save is sent. */
export function checkFamilies(families: readonly unknown[]): string | null {
  return families.length === 0 ? jobCriteriaCopy.families.errorNone : null
}

/** Server field errors placed on the form: the Match field, each list, and each chip by 0-based index. */
export interface ServerFieldErrors {
  readonly match: string | null
  /** v1.18.0: any field error on `targetRoleFamilies` shows `jobCriteria.families.errorServer`. */
  readonly families: string | null
  readonly lists: Readonly<Record<JobCriteriaListName, ListServerErrors>>
}

export interface ListServerErrors {
  /** Whole-list problem (`position: null`). */
  readonly list: string | null
  /** 0-based chip index to its message. */
  readonly entries: ReadonlyMap<number, string>
}

export const NO_SERVER_ERRORS: ServerFieldErrors = {
  match: null,
  families: null,
  lists: {
    frameworks: { list: null, entries: new Map() },
    technologies: { list: null, entries: new Map() },
  },
}

/**
 * Maps `fieldErrors` from a 400 to the form (contract v1.13.0). Returns null
 * when an error can't be shown on a field (an `invalid` list or entry: the
 * form never sends those shapes), so the caller shows the API message instead.
 */
export function mapServerFieldErrors(fieldErrors: readonly FieldError[], lists: Lists): ServerFieldErrors | null {
  let match: string | null = null
  let families: string | null = null
  const result: Record<JobCriteriaListName, { list: string | null; entries: Map<number, string> }> = {
    frameworks: { list: null, entries: new Map() },
    technologies: { list: null, entries: new Map() },
  }
  for (const error of fieldErrors) {
    if (error.field === "minCoreMatchPercent") {
      match = jobCriteriaCopy.matchError
      continue
    }
    // The Candidate can't act on "unknown key" or "duplicate": one message under the legend (design-spec.r1 J2 step 4).
    if (error.field === "targetRoleFamilies") {
      families = jobCriteriaCopy.families.errorServer
      continue
    }
    // The form always sends one of the two values, so a floor error can't be placed on a field.
    if (error.field === "seniorityFloor") return null
    const target = result[error.field]
    if (error.position === null) {
      if (error.problem !== "too_many_entries") return null
      target.list = jobCriteriaCopy.entryError.full
      continue
    }
    const index = error.position - 1
    const entry = lists[error.field][index]
    const message = entryProblemMessage(error.problem, entry)
    if (message === null || entry === undefined) return null
    target.entries.set(index, message)
  }
  return { match, families, lists: result }
}

function entryProblemMessage(problem: FieldError["problem"], entry: string | undefined): string | null {
  const errors = jobCriteriaCopy.entryError
  switch (problem) {
    case "entry_empty":
      return errors.empty
    case "entry_too_long":
      return errors.long
    case "entry_disallowed_characters":
      return errors.chars
    case "duplicate_entry":
      return jobCriteriaCopy.duplicateServer(entry ?? "")
    case "too_many_entries":
      return errors.full
    case "invalid":
    case "too_few_entries":
    case "unknown_entry":
      return null
  }
}
