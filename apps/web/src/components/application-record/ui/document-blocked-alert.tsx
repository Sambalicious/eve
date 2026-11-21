import { CircleX } from "lucide-react"
import { useId } from "react"

import { applicationCopy, type BlockedClaimCause, type DocumentKind } from "@/entities/application"
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert"
import { Button } from "@/shared/ui/button"

/** OD-1: the causes whose alert lists flagged terms. Mirrors `BLOCKED_CLAIM_TERMS_CAUSES`. */
const TERMS_CAUSES: ReadonlySet<BlockedClaimCause> = new Set(["unsupported_terms", "number_order", "no_fact"])

const REASON: Record<BlockedClaimCause, (document: ReturnType<typeof documentLabel>) => string> = {
  unsupported_terms: applicationCopy.blocked.reason.unsupportedTerms,
  number_order: applicationCopy.blocked.reason.numberOrder,
  no_fact: applicationCopy.blocked.reason.noFact,
  contact_detail: applicationCopy.blocked.reason.contactDetail,
  names_target: applicationCopy.blocked.reason.namesTarget,
  unknown_fact: applicationCopy.blocked.reason.unknownFact,
  not_confirmed: applicationCopy.blocked.reason.notConfirmed,
  skill_only_in_bullet: applicationCopy.blocked.reason.skillOnlyInBullet,
  added_fact_hedge: applicationCopy.blocked.reason.addedFactHedge,
}

function documentLabel(kind: DocumentKind) {
  return kind === "resume" ? ("resume" as const) : ("cover letter" as const)
}

export type DocumentBlockedProps = Readonly<{
  document: DocumentKind
  claim: string | null
  /** v1.30.0: null for a row blocked before this release, or a cause this build does not know. */
  cause: BlockedClaimCause | null
  terms: readonly string[] | null
  moreTerms: number | null
  /**
   * v1.32.0 (FEAT-0017, PRD 2.7, OD-10, C-AF-44 / C-AF-45): the one action this alert may carry,
   * offered only for `unsupported_terms` on an Editable Application that is not busy. The page
   * decides that by passing the callback; the term is the first listed one, or null when none is.
   */
  onAddFact?: (term: string | null) => void
}>

/**
 * C-DOC-3, destructive (design-spec.r2.md). Cause first, then count: the cause decides whether a list
 * can appear at all, so a `not_confirmed` block shows none even if terms arrive. Every term and the
 * blocked text are model output, so they render as plain text: a `<bdi>` text node inside an `<li>`,
 * and a `<blockquote>`.
 */
export function DocumentBlockedAlert({ document, claim, cause, terms, moreTerms, onAddFact }: DocumentBlockedProps) {
  const labelId = useId()
  const label = documentLabel(document)
  const reason = cause === null ? applicationCopy.blocked.reason.fallback(label) : REASON[cause](label)
  const showsTerms = cause !== null && TERMS_CAUSES.has(cause)
  const listed = showsTerms && terms !== null ? terms : []
  const overflow = showsTerms && moreTerms !== null && moreTerms > 0 ? moreTerms : 0
  const showsAddFact = cause === "unsupported_terms" && onAddFact !== undefined
  const addFactTerm = listed.length > 0 ? listed[0]! : null
  const labelText =
    cause === "number_order"
      ? listed.length === 1
        ? applicationCopy.blocked.numbersLabel.one
        : applicationCopy.blocked.numbersLabel.other
      : listed.length === 1
        ? applicationCopy.blocked.termsLabel.one
        : applicationCopy.blocked.termsLabel.other

  return (
    <Alert variant="destructive">
      <CircleX aria-hidden="true" />
      <AlertTitle>{applicationCopy.blocked.title}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2 text-pretty [&_p:not(:last-child)]:mb-0">
        <p className="max-w-[72ch]">{reason}</p>
        {listed.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p id={labelId} className="text-[13px] font-medium">
              {labelText}
            </p>
            <ul role="list" aria-labelledby={labelId} className="flex max-w-[72ch] flex-wrap gap-1.5">
              {listed.map((term) => (
                <li
                  key={term}
                  className={`max-w-full border px-2 py-0.5 text-[13px] leading-5 font-medium text-foreground [overflow-wrap:anywhere] ${
                    term.length > 32 ? "rounded-[10px]" : "rounded-full"
                  }`}
                >
                  <bdi>{term}</bdi>
                </li>
              ))}
            </ul>
            {overflow > 0 && (
              <p className="text-[13px]">
                {overflow === 1 ? applicationCopy.blocked.overflow.one(overflow) : applicationCopy.blocked.overflow.other(overflow)}
              </p>
            )}
          </div>
        )}
        {listed.length === 0 && overflow > 0 && (
          <p className="text-[13px]">
            {overflow === 1 ? applicationCopy.blocked.overflow.one(overflow) : applicationCopy.blocked.overflow.other(overflow)}
          </p>
        )}
        {showsAddFact && (
          // Design review [6b] note: as plain red text it read as a label. The underline marks the
          // ghost button as actionable; its hover and focus ring come from Button and stay.
          <Button
            id="document-blocked-add-fact"
            type="button"
            variant="ghost"
            size="sm"
            className="w-fit underline underline-offset-4 pointer-coarse:min-h-11"
            onClick={() => onAddFact?.(addFactTerm)}
          >
            {addFactTerm === null ? applicationCopy.blocked.addFact : applicationCopy.blocked.addFactAbout(addFactTerm)}
          </Button>
        )}
        {claim && (
          <div className="flex flex-col gap-1.5">
            <p className="text-[13px] font-medium">{applicationCopy.blocked.claimLabel}</p>
            <blockquote className="max-w-[72ch] border-l-2 border-primary/30 pl-3 text-sm leading-normal whitespace-pre-line text-foreground [overflow-wrap:anywhere]">
              {claim}
            </blockquote>
          </div>
        )}
      </AlertDescription>
    </Alert>
  )
}
