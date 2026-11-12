import { queryOptions } from "@tanstack/react-query"

import { fetchContactDetails } from "../api/contact-repository"

export const contactQueryKey = ["candidate-contact"] as const

export function contactQueryOptions() {
  return queryOptions({ queryKey: contactQueryKey, queryFn: fetchContactDetails })
}
