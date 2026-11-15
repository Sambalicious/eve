import { HIRING_PHRASES, type HiringSearchGroup } from "@eve/contracts"

import { hiringCopy as h } from "@/entities/stack-post"
import { Section } from "@/shared/ui/section"
import { HiringGroupRow, type HiringGroupNames } from "./hiring-search-links-section"
import { LiveRegion } from "./search-group-parts"
import { useAnnouncer } from "./use-announcer"

export const BROAD_HIRING_SEARCH_SECTION_ID = "broad-hiring-search"

const broadNames: HiringGroupNames = {
  linkedin: h.broadLinkLinkedInSr,
  google: h.broadLinkGoogleSr,
  alerts: h.broadAlertsToggleSr,
  queryBlock: h.broadQueryBlockSr,
  copy: h.broadCopySr,
}

/**
 * Broad hiring search (`#broad-hiring-search`): one row that searches the hiring
 * phrases plus every framework and technology the Candidate saved, with no role
 * family and no remote or relocation terms. It answers "show me any post that
 * says we're hiring and names my stack", which the role-family groups cannot:
 * those also require a job title and a hint term, and split the technologies in
 * fours. Renders what it is given and makes no request.
 */
export function BroadHiringSearchSection({
  group,
  onFeedsLink,
}: {
  group: HiringSearchGroup
  /** Moves to the Hiring Alert feeds section, from the link inside C-HP-ALERTQ-HOWTO-FEEDS. */
  onFeedsLink?: () => void
}) {
  const { announcement, announce } = useAnnouncer()
  return (
    <Section
      id={BROAD_HIRING_SEARCH_SECTION_ID}
      title={h.broadTitle}
      description={h.broadNote}
      headingProps={{ tabIndex: -1 }}
    >
      <div className="flex flex-col gap-4">
        <LiveRegion text={announcement} />
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[0.8125rem] text-muted-foreground">
          <dt className="font-medium">{h.broadPhrasesLabel}</dt>
          <dd className="[overflow-wrap:anywhere]">{h.titlesValue(HIRING_PHRASES)}</dd>
        </dl>
        <ul className="flex flex-col divide-y border-y">
          <HiringGroupRow
            group={group}
            names={broadNames}
            position={null}
            onCopied={() => announce(h.broadLiveCopied)}
            onFeedsLink={onFeedsLink}
          />
        </ul>
      </div>
    </Section>
  )
}
