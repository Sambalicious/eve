import type { PostingTechnology } from "@/entities/job-posting"

/** Rows shown before "Show all {n}" (design-spec B3). */
export const TECHNOLOGIES_SHOWN = 12

/** Matched technologies first, then the rest, each group in stored (model) order. */
export function orderTechnologies(technologies: readonly PostingTechnology[]): PostingTechnology[] {
  return [...technologies.filter((t) => t.inCriteria), ...technologies.filter((t) => !t.inCriteria)]
}
