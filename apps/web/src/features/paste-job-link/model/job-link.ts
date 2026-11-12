/** C-VAL-LINK-1 and C-VAL-LINK-2, same text as the contract's `job_link_empty` and `job_link_invalid`. */
export const LINK_EMPTY = "Paste a job link."
export const LINK_INVALID = "Enter a full link that starts with https:// or http://."

/**
 * The dashboard's check before sending. The backend checks again and has the
 * final word; its refusals show the same strings.
 */
export function jobLinkProblem(input: string): string | null {
  const value = input.trim()
  if (value === "") return LINK_EMPTY
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return LINK_INVALID
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return LINK_INVALID
  if (url.username || url.password || !url.hostname) return LINK_INVALID
  return null
}
