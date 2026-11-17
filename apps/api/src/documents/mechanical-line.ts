import { type DocumentLine } from "./document-model.js"
import { meaningKey, mechanicalKey } from "./line-text.js"
import { type FactWording, type LineKind } from "./claim-types.js"

/** One cited fact's own text, never its section heading. */
export function factTextOf(id: string, facts: ReadonlyMap<string, string>, wording: FactWording): string {
  const exact = wording?.get(id)
  if (exact !== undefined) return exact
  const value = facts.get(id) ?? ""
  const headingAt = value.indexOf(". ")
  return headingAt === -1 ? value : value.slice(0, headingAt)
}

/**
 * EPIC-0012 Revision 2, 2.1: a line passes without the judge only when it is mechanical: one cited
 * fact's own wording, two or more whole fact wordings joined, or a reordered or reduced list from one
 * fact's list. Everything else is a reword and reaches the meaning check.
 */
export function isMechanicalLine(
  text: string,
  factIds: readonly string[],
  facts: ReadonlyMap<string, string>,
  wording: FactWording,
  kind: LineKind
): boolean {
  if (factIds.length === 0) return false
  const line = mechanicalKey(text, kind === "letter_paragraph")
  if (line === "") return false
  const wordings = factIds.map((id) => mechanicalKey(factTextOf(id, facts, wording), kind === "letter_paragraph"))
  if (wordings.some((fact) => fact !== "" && fact === line)) return true
  return joinedFactWordings(line, wordings) || listFromOneFact(line, wordings, kind)
}

/** Two or more whole fact wordings joined by ", and ", " and ", "; " or ". " (Revision 2, 2.1). */
function joinedFactWordings(line: string, wordings: readonly string[]): boolean {
  const facts = [...new Set(wordings.filter((fact) => fact !== ""))]
  const separators = [", and ", " and ", "; ", ". "]
  const walk = (rest: string, used: number): boolean => {
    if (used >= 2 && rest === "") return true
    for (const fact of facts) {
      if (!rest.startsWith(fact)) continue
      const after = rest.slice(fact.length)
      if (after === "" && used + 1 >= 2) return true
      for (const separator of separators) {
        if (after.startsWith(separator) && walk(after.slice(separator.length), used + 1)) return true
      }
    }
    return false
  }
  return walk(line, 0)
}

/** Labels a technologies bullet may use and still be a "Label: a, b, c" list (Revision 2, 2.1). */
const TECHNOLOGY_LABELS: ReadonlySet<string> = new Set([
  "language", "languages", "tool", "tools", "technology", "technologies", "tech", "stack", "skill", "skills",
  "framework", "frameworks", "library", "libraries", "platform", "platforms", "database", "databases", "cloud",
  "devops", "testing", "methodology", "methodologies", "technical", "core", "key", "other",
])

/** A skills line, or a "Label: a, b, c" bullet, whose comma items all sit in one cited fact's list (2.1). */
function listFromOneFact(line: string, wordings: readonly string[], kind: LineKind): boolean {
  let body = line
  if (kind !== "skills") {
    const colon = body.indexOf(":")
    if (colon === -1) return false
    const label = body.slice(0, colon).trim().split(/\s+/)
    if (label.length === 0 || !label.every((word) => TECHNOLOGY_LABELS.has(word))) return false
    body = body.slice(colon + 1)
  }
  const items = listItems(body)
  if (items.length === 0) return false
  return wordings.some((fact) => {
    const factItems = listItems(fact)
    return factItems.length >= 2 && items.every((item) => factItems.includes(item))
  })
}

function listItems(text: string): string[] {
  return text.split(",").map((item) => item.trim()).filter((item) => item !== "")
}

/** True when a meaning-check verdict exists for this line text and its fact ids (Revision 2, R15). */
export function isMeaningChecked(meaningChecked: ReadonlySet<string>, line: DocumentLine): boolean {
  return meaningChecked.has(meaningKey(line.text, line.factIds))
}
