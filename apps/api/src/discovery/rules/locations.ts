import { PLACES, escapeRegExp } from "./places.js"

/**
 * Relocation destinations (AC 4.3). EPIC-0002 B1: the excluded countries are
 * the evaluated Candidate's `excludedRelocationCountries` (ISO codes), not a
 * list here; the place names come from the shared catalog (`places.ts`).
 * A destination is stored by its catalog display name, as before.
 */

/** Countries named in `folded` text (already lower case), in the order they appear, by display name. */
export function countriesIn(folded: string): string[] {
  const found: Array<[index: number, country: string]> = []
  for (const place of PLACES) {
    for (const name of place.names) {
      const match = new RegExp(`(^|[^a-z])${escapeRegExp(name)}([^a-z]|$)`).exec(folded)
      if (match) found.push([match.index, place.name])
    }
  }
  found.sort((a, b) => a[0] - b[0])
  return [...new Set(found.map(([, country]) => country))]
}

/** The country whose name or city begins `folded` (lower case), or null. "react server components" is null. */
export function countryAtStart(folded: string): string | null {
  for (const place of PLACES) {
    for (const name of place.names) {
      if (new RegExp(`^${escapeRegExp(name)}([^a-z]|$)`).test(folded)) return place.name
    }
  }
  return null
}

/** The ISO code of a catalog display name, or null. */
export function codeOfCountry(name: string): string | null {
  return PLACES.find((place) => place.name === name)?.code ?? null
}
