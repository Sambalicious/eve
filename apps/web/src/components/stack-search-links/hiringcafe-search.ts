import { type RoleFamilyValue, ROLE_FAMILY_HIRING_PHRASES, hiringFamilies } from "@eve/contracts"

const HIRINGCAFE_SEARCH_BASE = "https://hiring.cafe/"

export type HiringCafeLink = Readonly<{ family: RoleFamilyValue; label: string; href: string }>

/** A HiringCafe search for one job title. The link only opens their site; Eve reads nothing from it. */
export function hiringCafeUrl(title: string): string {
  return `${HIRINGCAFE_SEARCH_BASE}?searchState=${encodeURIComponent(JSON.stringify({ searchQuery: title }))}`
}

/** One link per target role family, using the family's first title phrase. */
export function hiringCafeLinks(targets: readonly RoleFamilyValue[]): HiringCafeLink[] {
  return hiringFamilies(targets).map((family) => {
    const title = ROLE_FAMILY_HIRING_PHRASES[family][0]!
    return { family, label: title, href: hiringCafeUrl(title) }
  })
}
