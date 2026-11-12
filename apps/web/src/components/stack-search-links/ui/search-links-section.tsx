import { useId, useState } from "react"
import { ListChecks } from "lucide-react"
import { type StackSearchGroup } from "@eve/contracts"

import { stackPostsCopy as c } from "@/entities/stack-post"
import { ButtonLink } from "@/shared/ui/button-link"
import { Collapsible, CollapsibleContent } from "@/shared/ui/collapsible"
import { QuietEmpty, Section } from "@/shared/ui/section"
import { AlertsHowTo, AlertsToggle, LiveRegion, QueryBlock, SearchLink } from "./search-group-parts"
import { useAnnouncer } from "./use-announcer"

const JOB_CRITERIA_LINK = "/settings#job-criteria"

type QueryKind = "posts" | "articles"

/**
 * Search links (`#search-links`, design-spec B1): one row per group of up to 8
 * terms with three new-tab links and a collapsed Google Alerts queries panel.
 * Groups come from `buildStackSearchGroups`; this component makes no request.
 * `content` replaces the body for the loading and error states.
 */
export function SearchLinksSection({ groups, content }: { groups: readonly StackSearchGroup[] | undefined; content?: React.ReactNode }) {
  const { announcement, announce } = useAnnouncer()

  const hasGroups = groups !== undefined && groups.length > 0
  return (
    <Section
      id="search-links"
      title={c.linksTitle}
      description={hasGroups ? c.linksDesc : undefined}
      headingProps={{ tabIndex: -1 }}
      actions={
        hasGroups && (
          <ButtonLink variant="ghost" size="sm" to={JOB_CRITERIA_LINK}>
            {c.linksEdit}
          </ButtonLink>
        )
      }
    >
      <LiveRegion text={announcement} />
      {groups === undefined ? (
        content
      ) : groups.length === 0 ? (
        <QuietEmpty
          icon={<ListChecks />}
          titleAs="h3"
          title={c.linksEmptyTitle}
          description={c.linksEmptyBody}
          action={
            <ButtonLink variant="outline" size="sm" to={JOB_CRITERIA_LINK}>
              {c.linksEmptyAction}
            </ButtonLink>
          }
        />
      ) : (
        <ul className="flex flex-col divide-y border-y">
          {groups.map((group, index) => (
            <GroupRow
              key={group.label}
              group={group}
              position={groups.length > 1 ? c.groupN(index + 1, groups.length) : null}
              onCopied={(kind) => announce(c.liveCopied[kind])}
            />
          ))}
        </ul>
      )}
    </Section>
  )
}

function GroupRow({ group, position, onCopied }: { group: StackSearchGroup; position: string | null; onCopied: (kind: QueryKind) => void }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  return (
    <li className="flex flex-col gap-2 py-3">
      {position && <span className="text-[0.78125rem] font-medium text-muted-foreground uppercase">{position}</span>}
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex flex-col gap-2 md:grid md:grid-cols-[minmax(0,20rem)_minmax(min-content,1fr)] md:gap-x-6">
          <span className="text-sm font-medium [overflow-wrap:anywhere]">{group.label}</span>
          <div className="flex flex-col items-start gap-2">
            <div className="flex flex-wrap gap-2">
              <SearchLink href={group.linkedin} label={c.linkLinkedIn} accessibleName={c.linkSr(c.linkLinkedIn, group.label)} />
              <SearchLink href={group.googlePosts} label={c.linkGooglePosts} accessibleName={c.linkSr(c.linkGooglePosts, group.label)} />
              <SearchLink
                href={group.googleArticles}
                label={c.linkGoogleArticles}
                accessibleName={c.linkSr(c.linkGoogleArticles, group.label)}
              />
            </div>
            <AlertsToggle open={open} panelId={`${id}-panel`} label={c.alertsToggle} accessibleName={c.alertsToggleSr(group.label)} />
          </div>
        </div>
        <CollapsibleContent id={`${id}-panel`} className="flex flex-col gap-3 pt-2">
          <AlertsHowTo text={c.alertsHowTo} />
          <div className="grid gap-3 lg:grid-cols-2">
            {(["posts", "articles"] as const).map((kind) => (
              <QueryBlock
                key={kind}
                query={kind === "posts" ? group.alertsPostsQuery : group.alertsArticlesQuery}
                label={c.queryLabel[kind]}
                copyName={c.copySr[kind](group.label)}
                blockName={c.queryBlockSr[kind](group.label)}
                onCopied={() => onCopied(kind)}
              />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}
