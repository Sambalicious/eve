/**
 * `/stack-posts` becomes `/find-jobs` (AC-5.6). The Hiring view keeps its `view`, `page` and `family` params
 * and its `#hiring-posts` anchor, so email links keep working. The Stack view's page moves to `spage`
 * (Hiring posts own `page` on the new screen) and its `#posts` anchor to `#practitioner-posts`.
 */
export function stackPostsTarget(search: string, hash: string): string {
  const params = new URLSearchParams(search)
  if (params.get("view") === "hiring") return `/find-jobs${search}${hash}`
  params.delete("view")
  const page = params.get("page")
  if (page !== null) {
    params.delete("page")
    params.set("spage", page)
  }
  const query = params.toString()
  const anchor = hash === "" || hash === "#posts" ? "#practitioner-posts" : hash
  return `/find-jobs${query ? `?${query}` : ""}${anchor}`
}
