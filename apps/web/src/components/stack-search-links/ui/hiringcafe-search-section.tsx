import { type RoleFamilyValue } from "@eve/contracts"

import { Section } from "@/shared/ui/section"
import { hiringCafeLinks } from "../hiringcafe-search"
import { SearchLink } from "./search-group-parts"

/**
 * Links that open HiringCafe's own search for each target role. Eve makes no
 * request to HiringCafe and stores nothing from it; their terms bar copying
 * their listings. Renders nothing without a target role.
 */
export function HiringCafeSearchSection({ targets }: { targets: readonly RoleFamilyValue[] }) {
  const links = hiringCafeLinks(targets)
  if (links.length === 0) return null
  return (
    <Section
      id="hiringcafe-search"
      title="Search HiringCafe"
      description="Opens HiringCafe in a new tab with your target role. Eve doesn't read their listings, so add a job you like with Check this job."
    >
      <div className="flex flex-wrap gap-2">
        {links.map((link) => (
          <SearchLink key={link.family} href={link.href} label={link.label} accessibleName={`Search HiringCafe for ${link.label}`} />
        ))}
      </div>
    </Section>
  )
}
