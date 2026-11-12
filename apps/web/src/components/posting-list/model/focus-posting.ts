/**
 * Focuses a posting's title link in whichever list is on screen: the table
 * from 768px or the card list below (both are rendered; CSS hides one). Falls
 * back to the first match when nothing has a layout box (tests, print).
 */
export function focusPostingTitle(container: HTMLElement, postingId: string): boolean {
  const links = [...container.querySelectorAll<HTMLElement>(`[data-posting-link="${postingId}"]`)]
  const link = links.find((element) => element.getClientRects().length > 0) ?? links[0]
  if (!link) return false
  link.focus()
  link.scrollIntoView?.({ block: "nearest" })
  return true
}
