/**
 * Application URL handling: the normalised URL is half of the requisition key
 * (AC 3.2), and its host decides the Application System (AC 3.4).
 */
export type AtsLocator =
  | Readonly<{ system: "greenhouse"; board: string; jobId: string }>
  | Readonly<{ system: "lever"; board: string; jobId: string }>
  | Readonly<{ system: "ashby"; board: string; jobId: string }>

const TRACKING = /^(utm_|gh_src$|gh_jid$|lever-source|source$|ref$|src$)/i

/**
 * Lower-case host, no default port, no fragment, no tracking parameters, no
 * trailing slash. Anything that is not an http(s) URL is returned unchanged,
 * so `isWebUrl` still refuses it downstream (SEC-301) and one bad value never
 * throws for the whole board.
 */
export function normaliseApplicationUrl(raw: string): string {
  if (!isWebUrl(raw)) return raw
  const url = new URL(raw)
  url.hash = ""
  url.hostname = url.hostname.toLowerCase().replace(/^(www\.)+/, "")
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = ""
  url.protocol = "https:"
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key)
  url.searchParams.sort()
  url.pathname = stablePath(url.pathname)
  return url.toString()
}

/** SEC-511: trailing slashes and "/apply" are removed until none is left, so normalising twice changes nothing. */
function stablePath(pathname: string): string {
  let path = pathname
  for (;;) {
    const next = path.replace(/\/+$/, "").replace(/\/apply$/, "")
    if (next === path) return path || "/"
    path = next
  }
}

/** Reads a Greenhouse, Lever or Ashby posting URL. Anything else is not supported for automatic submission. */
export function locateAts(raw: string): AtsLocator | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "")
  const parts = url.pathname.split("/").filter(Boolean)
  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io" || host === "job-boards.eu.greenhouse.io") {
    const jobsAt = parts.indexOf("jobs")
    if (jobsAt === 1 && parts[0] && parts[2] && /^\d+$/.test(parts[2])) return { system: "greenhouse", board: parts[0], jobId: parts[2] }
    const embedJob = url.searchParams.get("token") ?? url.searchParams.get("gh_jid")
    const embedBoard = url.searchParams.get("for")
    if (embedJob && embedBoard && /^\d+$/.test(embedJob)) return { system: "greenhouse", board: embedBoard, jobId: embedJob }
    return null
  }
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") {
    if (parts[0] && parts[1]) return { system: "lever", board: parts[0], jobId: parts[1] }
    return null
  }
  if (host === "jobs.ashbyhq.com") {
    if (parts[0] && parts[1]) return { system: "ashby", board: parts[0], jobId: parts[1] }
    return null
  }
  return null
}

const KNOWN_SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/myworkdayjobs\.com$|workday\.com$/, "Workday"],
  [/smartrecruiters\.com$/, "SmartRecruiters"],
  [/workable\.com$/, "Workable"],
  [/bamboohr\.com$/, "BambooHR"],
  [/icims\.com$/, "iCIMS"],
  [/taleo\.net$/, "Taleo"],
  [/recruitee\.com$/, "Recruitee"],
  [/teamtailor\.com$/, "Teamtailor"],
  [/personio\.(de|com)$/, "Personio"],
  [/breezy\.hr$/, "Breezy HR"],
  [/jazzhr\.com$|applytojob\.com$/, "JazzHR"],
  [/himalayas\.app$/, "Himalayas"],
  [/remoteok\.com$/, "Remote OK"],
  [/weworkremotely\.com$/, "We Work Remotely"],
  [/remotive\.com$/, "Remotive"],
]

/** Display name of the Application System, for C-SKIP-3. */
export function applicationSystemName(raw: string): string {
  const ats = locateAts(raw)
  if (ats) return { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby" }[ats.system]
  const host = new URL(raw).hostname.toLowerCase()
  for (const [pattern, name] of KNOWN_SYSTEMS) if (pattern.test(host)) return name
  return host.replace(/^www\./, "")
}

export type LinkCheck = Readonly<{ ok: true; url: string }> | Readonly<{ ok: false; code: "job_link_empty" | "job_link_invalid" }>

/** C-VAL-LINK-1 and C-VAL-LINK-2: empty, or not an absolute http(s) URL. */
export function checkPastedLink(raw: string): LinkCheck {
  const trimmed = raw.trim()
  if (trimmed === "") return { ok: false, code: "job_link_empty" }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, code: "job_link_invalid" }
  }
  if (!isWebUrl(url.toString()) || url.username !== "" || url.password !== "") {
    return { ok: false, code: "job_link_invalid" }
  }
  return { ok: true, url: url.toString() }
}

/** True only for an absolute http: or https: URL with a host. data:, javascript:, file: and the rest are refused (SEC-301). */
export function isWebUrl(raw: string): boolean {
  if (raw !== raw.trim()) return false
  try {
    const url = new URL(raw)
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname !== ""
  } catch {
    return false
  }
}
