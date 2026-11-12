import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"

import { applicationsQueryKey, submissionListQueryKey, submissionListQueryOptions, submissionQueryKey } from "@/entities/application"
import { refreshSubmissions } from "./use-submission-action"

/** CR-03: `keepLists` compares against the exported list key prefix, not a hard-coded key shape. */
describe("refreshSubmissions", () => {
  const KEYS = {
    blockedList: submissionListQueryOptions("blocked").queryKey,
    uncertainList: submissionListQueryOptions("uncertain").queryKey,
    one: [...submissionQueryKey, "one", "a1"],
    summary: [...submissionQueryKey, "summary"],
    applications: [...applicationsQueryKey, "x"],
  } as const

  function seeded() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    for (const key of Object.values(KEYS)) client.setQueryData(key, { seeded: true })
    return client
  }
  const invalidated = (client: QueryClient) =>
    Object.fromEntries(Object.entries(KEYS).map(([name, key]) => [name, client.getQueryState(key)?.isInvalidated ?? null]))

  it("the list key prefix is the one every list query starts with", () => {
    expect(submissionListQueryKey).toEqual(["submission", "list"])
    expect(KEYS.blockedList.slice(0, 2)).toEqual([...submissionListQueryKey])
  })

  it("invalidates every Submission and Application query by default", async () => {
    const client = seeded()
    await refreshSubmissions(client)
    expect(invalidated(client)).toEqual({ blockedList: true, uncertainList: true, one: true, summary: true, applications: true })
  })

  it("with keepLists, keeps every list query and invalidates the rest", async () => {
    const client = seeded()
    await refreshSubmissions(client, { keepLists: true })
    expect(invalidated(client)).toEqual({ blockedList: false, uncertainList: false, one: true, summary: true, applications: true })
  })
})
