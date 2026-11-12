/**
 * Marks `target` and every reveal section above it revealed, with transitions
 * off for two frames, so an in-page jump or a hash load lands on finished
 * content and nothing above reveals behind the visitor (design-spec r1 5).
 */
export function revealThrough(root: HTMLElement, target: Element): void {
  const sections = [...root.querySelectorAll<HTMLElement>("[data-reveal]")]
  for (const section of sections) {
    const atOrAbove = section === target || Boolean(section.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING)
    if (atOrAbove) revealNow(section)
  }
}

/** Shows a section at once: revealed, with its transitions off for two frames. */
export function revealNow(section: HTMLElement): void {
  if (section.hasAttribute("data-revealed")) return
  section.setAttribute("data-reveal-instant", "")
  section.setAttribute("data-revealed", "")
  requestAnimationFrame(() => requestAnimationFrame(() => section.removeAttribute("data-reveal-instant")))
}

/** True when the boot script allowed motion (`html.motion-ok`). */
export function motionAllowed(): boolean {
  return document.documentElement.classList.contains("motion-ok")
}
