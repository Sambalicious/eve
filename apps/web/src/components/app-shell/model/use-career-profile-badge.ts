import { useQuery } from "@tanstack/react-query"

import { careerProfileQueryOptions } from "@/entities/career-profile"

/** The Career Profile nav item shows "Draft" until a version is approved (design-spec, Navigation). */
export function useCareerProfileBadge(): string | null {
  const { data } = useQuery(careerProfileQueryOptions())
  return data && data.inUse === null && data.draft !== null ? "Draft" : null
}
