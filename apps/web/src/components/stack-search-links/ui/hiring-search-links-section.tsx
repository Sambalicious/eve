import { useId, useState } from "react"
import { BriefcaseBusiness, Info } from "lucide-react"
import { Link } from "react-router-dom"
import type { RoleFamilyValue } from "@eve/contracts"

import { roleFamilyLabel } from "@/entities/job-posting"
import { hiringCopy as h, stackPostsCopy as c } from "@/entities/stack-post"
import { HIRING_ALERT_FEEDS_SECTION_ID } from "@/features/manage-alert-feeds"
import { CHECK_THIS_JOB_SECTION_ID } from "@/features/paste-job-link"
import type { HiringHintTerm, HiringSearchGroup } from "@/shared/lib/hiring-contracts"
import { ButtonLink } from "@/shared/ui/button-link"
import { Collapsible, CollapsibleContent } from "@/shared/ui/collapsible"
import { NativeSelect } from "@/shared/ui/native-select"
import { QuietEmpty, Section, SectionNote } from "@/shared/ui/section"
import { AlertsHowTo, AlertsToggle, LiveRegion, QueryBlock, SearchLink } from "./search-group-parts"
import { useAnnouncer } from "./use-announcer"

export const HIRING_SEARCH_LINKS_SECTION_ID = "hiring-search-links"
const JOB_CRITERIA_LINK = "/settings#job-criteria"

/** What the section shows. Only `ready` renders the C-HP-HINT note (design-spec r1 H2, H4 step 1). */
export type HiringSearchLinksState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "error" }>
  | Readonly<{ kind: "no-family" }>
  | Readonly<{
      kind: "ready"
      /** The target families with phrases, catalog order; never empty. */
      families: readonly RoleFamilyValue[]
      family: RoleFamilyValue
      phrases: readonly string[]
      hintTerms: readonly HiringHintTerm[]
      groups: readonly HiringSearchGroup[]
    }>

/**
 * Hiring search links (`#hiring-search-links`, EPIC-0007 design-spec r1 B1,
 * H2, H3). Renders what it is given and makes no request; `onFamilyChange`
 * reports a new Role family choice, and `loadingBody` / `errorBody` fill the
 * section while its data loads or after it failed.
 */
export function HiringSearchLinksSection({
  state,
  onFamilyChange,
  onHintLink,
  onFeedsLink,
  loadingBody,
  errorBody,
}: {
  state: HiringSearchLinksState
  onFamilyChange: (family: RoleFamilyValue) => void
  /** Moves to the Check this job section (C-HP-HINT-LINK). */
  onHintLink: () => void
  /**
   * Phase 3: moves to the Hiring Alert feeds section from the link inside
   * C-HP-ALERTQ-HOWTO-FEEDS. Absent before Phase 3, when the disclosure shows
   * C-HP-ALERTQ-HOWTO (design-spec r2 H3 step 2).
   */
  onFeedsLink?: () => void
  loadingBody: React.ReactNode
  errorBody: React.ReactNode
}) {
  const { announcement, announce } = useAnnouncer()
  return (
    <Section
      id={HIRING_SEARCH_LINKS_SECTION_ID}
      title={h.linksTitle}
      headingProps={{ tabIndex: -1 }}
      actions={
        state.kind === "ready" && (
          <ButtonLink variant="ghost" size="sm" to={JOB_CRITERIA_LINK}>
            {h.linksEdit}
          </ButtonLink>
        )
      }
    >
      <LiveRegion text={announcement} />
      {state.kind === "loading" ? (
        loadingBody
      ) : state.kind === "error" ? (
        errorBody
      ) : state.kind === "no-family" ? (
        <QuietEmpty
          icon={<BriefcaseBusiness />}
          titleAs="h3"
          title={h.noFamilyTitle}
          description={h.noFamilyBody}
          action={
            <ButtonLink variant="outline" size="sm" to={JOB_CRITERIA_LINK}>
              {h.noFamilyAction}
            </ButtonLink>
          }
        />
      ) : (
        <ReadyBody
          state={state}
          onHintLink={onHintLink}
          onFeedsLink={onFeedsLink}
          onFamilyChange={(family) => {
            onFamilyChange(family)
            announce(h.liveFamily(roleFamilyLabel[family]))
          }}
          onCopied={() => announce(h.liveCopied)}
        />
      )}
    </Section>
  )
}

function ReadyBody({
  state,
  onFamilyChange,
  onHintLink,
  onFeedsLink,
  onCopied,
}: {
  state: Extract<HiringSearchLinksState, { kind: "ready" }>
  onFamilyChange: (family: RoleFamilyValue) => void
  onHintLink: () => void
  onFeedsLink?: () => void
  onCopied: () => void
}) {
  const selectId = useId()
  const familyName = roleFamilyLabel[state.family]
  const anyTechnology = state.groups.length === 1 && state.groups[0].terms.length === 0
  return (
    <div className="flex flex-col gap-4">
      <SectionNote className="flex items-start gap-2.5">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p>
          {h.hint}{" "}
          <a
            href={`#${CHECK_THIS_JOB_SECTION_ID}`}
            onClick={(event) => {
              event.preventDefault()
              onHintLink()
            }}
            className="font-medium underline underline-offset-4"
          >
            {h.hintLink}
          </a>
        </p>
      </SectionNote>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:gap-8">
        {state.families.length > 1 ? (
          <div className="flex flex-col gap-1.5 sm:w-64 sm:shrink-0">
            <label htmlFor={selectId} className="text-sm font-medium">
              {h.familyLabel}
            </label>
            <NativeSelect
              id={selectId}
              value={state.family}
              onChange={(event) => {
                const next = state.families.find((family) => family === event.target.value)
                if (next) onFamilyChange(next)
              }}
            >
              {state.families.map((family) => (
                <option key={family} value={family}>
                  {roleFamilyLabel[family]}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : (
          <p className="text-sm font-medium lg:w-64 lg:shrink-0">{h.familySingle(familyName)}</p>
        )}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[0.8125rem] text-muted-foreground">
          <dt className="font-medium">{h.titlesLabel}</dt>
          <dd className="[overflow-wrap:anywhere]">{h.titlesValue(state.phrases)}</dd>
          {state.hintTerms.length > 0 && (
            <>
              <dt className="font-medium">{h.hintsLabel}</dt>
              <dd className="[overflow-wrap:anywhere]">{h.hintsValue(state.hintTerms)}</dd>
            </>
          )}
        </dl>
      </div>

      {anyTechnology && (
        <SectionNote className="flex items-start gap-2.5">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p>
            {h.anyTechNote}{" "}
            <Link to={JOB_CRITERIA_LINK} className="font-medium underline underline-offset-4">
              {h.anyTechNoteLink}
            </Link>
          </p>
        </SectionNote>
      )}

      <ul className="flex flex-col divide-y border-y">
        {state.groups.map((group, index) => (
          <HiringGroupRow
            // Labels can repeat (the same term saved twice), so the position keys the row.
            key={index}
            group={group}
            familyName={familyName}
            position={state.groups.length > 1 ? c.groupN(index + 1, state.groups.length) : null}
            onCopied={onCopied}
            onFeedsLink={onFeedsLink}
          />
        ))}
      </ul>
    </div>
  )
}

function HiringGroupRow({
  group,
  familyName,
  position,
  onCopied,
  onFeedsLink,
}: {
  group: HiringSearchGroup
  familyName: string
  position: string | null
  onCopied: () => void
  onFeedsLink?: () => void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const label = group.label || h.groupAny
  return (
    <li className="flex flex-col gap-2 py-3">
      {position && <span className="text-[0.78125rem] font-medium text-muted-foreground uppercase">{position}</span>}
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex flex-col gap-2 md:grid md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] md:gap-x-6">
          <span className="text-sm font-medium [overflow-wrap:anywhere]">{label}</span>
          <div className="flex flex-col items-start gap-2">
            <div className="flex flex-wrap gap-2">
              <SearchLink href={group.linkedin} label={h.linkLinkedIn} accessibleName={h.linkLinkedInSr(familyName, label)} />
              <SearchLink href={group.google} label={h.linkGoogle} accessibleName={h.linkGoogleSr(familyName, label)} />
            </div>
            <AlertsToggle open={open} panelId={`${id}-panel`} label={h.alertsToggle} accessibleName={h.alertsToggleSr(label)} />
          </div>
        </div>
        <CollapsibleContent id={`${id}-panel`} className="flex flex-col gap-3 pt-2">
          <AlertsHowTo
            text={
              onFeedsLink ? (
                <>
                  {h.alertsHowToFeeds.before}
                  <a
                    href={`#${HIRING_ALERT_FEEDS_SECTION_ID}`}
                    onClick={(event) => {
                      event.preventDefault()
                      onFeedsLink()
                    }}
                    className="font-medium text-foreground underline underline-offset-4"
                  >
                    {h.alertsHowToFeeds.link}
                  </a>
                  {h.alertsHowToFeeds.after}
                </>
              ) : (
                h.alertsHowTo
              )
            }
          />
          <QueryBlock
            query={group.alertsQuery}
            label={h.queryLabel}
            copyName={h.copySr(label)}
            blockName={h.queryBlockSr(label)}
            onCopied={onCopied}
          />
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}
