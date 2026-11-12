import { useId } from "react"
import { CircleAlert, Info } from "lucide-react"

import type { ProfileSection } from "../model/career-profile"
import { careerProfileCopy } from "../model/copy"

interface ProfileSectionsProps {
  sections: readonly ProfileSection[]
  /** Facts to mark with `invalidFactMessage`, such as empty facts refused on approval. */
  invalidFactIds?: readonly string[]
  invalidFactMessage?: string
}

/**
 * Read-only facts grouped by role (design-spec.r3 F1 step 3c): heading (title,
 * then employer and dates) and the heading's own quote, then each fact with
 * its fact ID in mono and its quote. Quotes sit under the visible label
 * C-PROFILE-Q1; a heading or fact with no quote shows C-PROFILE-Q2.
 */
export function ProfileSections({
  sections,
  invalidFactIds = [],
  invalidFactMessage,
}: ProfileSectionsProps) {
  return (
    <div className="flex flex-col">
      {sections.map((section) => (
        <section
          key={section.id}
          aria-labelledby={`section-${section.id}`}
          className="grid min-w-0 gap-4 border-t py-6 first:border-t-0 first:pt-2 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] md:gap-10"
        >
          <div className="flex min-w-0 flex-col gap-2">
            <SectionHeading section={section} />
            <SourceQuote quote={section.sourceQuote} />
          </div>
          <ul className="flex min-w-0 flex-col divide-y">
            {section.facts.map((fact) => (
              <li
                key={fact.id}
                className="flex min-w-0 flex-col gap-1.5 py-3 first:pt-0 last:pb-0"
              >
                <p className="text-sm leading-relaxed font-medium [overflow-wrap:anywhere]">
                  {fact.text}
                </p>
                {invalidFactMessage && invalidFactIds.includes(fact.id) && (
                  <p
                    role="alert"
                    className="flex items-start gap-2 text-sm text-destructive-text"
                  >
                    <CircleAlert
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0"
                    />
                    {invalidFactMessage}
                  </p>
                )}
                <div className="flex min-w-0 flex-col gap-1">
                  <SourceQuote quote={fact.sourceQuote} />
                  <p className="font-mono text-[12.5px] text-muted-foreground [overflow-wrap:anywhere]">
                    {fact.id}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/**
 * C-PROFILE-23, muted with an `Info` icon. Plain text in reading order, not a
 * live region, because it is there when the page loads. Hidden at 0.
 */
export function DroppedItemsLine({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <p className="flex max-w-[72ch] items-start gap-2 text-sm text-muted-foreground">
      <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{careerProfileCopy.dropped(count)}</span>
    </p>
  )
}

/**
 * The label C-PROFILE-Q1 above the quote block. The visible label names the
 * `figure` (explicitly, because not every engine maps `figcaption`), so a
 * screen reader hears it once, then the quote. There is no sr-only copy of the
 * label (design-spec.r3 Accessibility).
 */
function SourceQuote({ quote }: { quote: string | null }) {
  const labelId = useId()
  if (quote === null) {
    return (
      <p className="text-xs text-muted-foreground">
        {careerProfileCopy.writtenByYou}
      </p>
    )
  }
  return (
    <figure
      aria-labelledby={labelId}
      className="flex max-w-[72ch] flex-col gap-0.5"
    >
      <figcaption
        id={labelId}
        className="text-xs font-medium text-muted-foreground"
      >
        {careerProfileCopy.fromYourResume}
      </figcaption>
      <blockquote className="border-l-2 border-primary/30 pl-2.5 text-[0.8125rem] text-muted-foreground [overflow-wrap:anywhere]">
        {quote}
      </blockquote>
    </figure>
  )
}

function SectionHeading({ section }: { section: ProfileSection }) {
  const meta = [section.organization, section.period].filter(
    (part) => part !== null && part !== ""
  )
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <h3
        id={`section-${section.id}`}
        className="text-[0.9375rem] font-semibold tracking-[-0.01em] [overflow-wrap:anywhere]"
      >
        {section.title}
      </h3>
      {meta.length > 0 && (
        <p className="text-[0.8125rem] text-muted-foreground tabular-nums [overflow-wrap:anywhere]">
          {meta.join(" · ")}
        </p>
      )}
    </div>
  )
}
