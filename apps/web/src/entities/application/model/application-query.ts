import { queryOptions } from "@tanstack/react-query"

import { fetchApplication, fetchApplications, fetchDocumentBlob, fetchDocumentsList } from "../api/application-repository"

export const applicationsQueryKey = ["applications"] as const
export const documentsListQueryKey = ["documents-list"] as const

/** Poll while documents generate (design-spec, Real-time updates: 5 s). */
export const GENERATING_POLL_MS = 5_000

/** `retention` narrows the list to the due or waiting Applications (E5.7); null is the full list. */
export function applicationsQueryOptions(retention: "due" | "waiting" | null = null) {
  return queryOptions({
    queryKey: retention ? [...applicationsQueryKey, "list", { retention }] : [...applicationsQueryKey, "list"],
    queryFn: () => fetchApplications(retention),
  })
}

export function applicationQueryOptions(id: string) {
  return queryOptions({
    queryKey: [...applicationsQueryKey, "detail", id],
    queryFn: () => fetchApplication(id),
    refetchInterval: (query) => (query.state.data?.state === "generating" ? GENERATING_POLL_MS : false),
  })
}

export function documentsListQueryOptions() {
  return queryOptions({ queryKey: documentsListQueryKey, queryFn: fetchDocumentsList })
}

/** The PDF bytes for the inline preview; cached per URL, never refetched in the background. */
export function documentBlobQueryOptions(url: string) {
  return queryOptions({
    queryKey: ["document-blob", url],
    queryFn: () => fetchDocumentBlob(url),
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
  })
}
