import { Check, CircleAlert, TriangleAlert } from "lucide-react"
import { useId, useState } from "react"

import type { AddedFact, AddedFactsConfirmation, ApplicationMatch, Submission } from "@eve/contracts"

import { Button } from "@/shared/ui/button"
import { Section } from "@/shared/ui/section"

import type { AddedFactsFailure, AddedFactsResult } from "../model/added-facts-actions"
import { addedFactsCopy } from "../model/copy"

type Props = Readonly<{
  match: ApplicationMatch
  facts: readonly AddedFact[]
  confirmation: AddedFactsConfirmation
  isConfirming: boolean
  showOverrideNote: boolean
  onConfirm: () => Promise<AddedFactsResult<Submission>>
}>

/**
 * "Submit with your added skills" (OD-7, OD-17; design-spec.r1 blueprint 6). The tap is the queue
 * tap: no dialog. Shown only for an Editable Application whose Match is strong with the added facts.
 * Reversible with the existing "Remove from queue".
 */
export function AddedFactsLiftPanel({ match, facts, confirmation, isConfirming, showOverrideNote, onConfirm }: Props) {
  const reasonId = useId()
  // `retry` is false for a refusal another state explains (C-AF-57 and the stale, frozen and busy
  // lines): repeating the same tap repeats the same answer, so only C-AF-58 offers "Try again".
  const [error, setError] = useState<Readonly<{ text: string; retry: boolean }> | null>(null)

  const confirmed = confirmation.state === "confirmed"
  const waiting = confirmation.state === "stale" || confirmation.state === "needs_documents"
  const voided = confirmation.voided && !confirmed

  async function confirm() {
    if (isConfirming || waiting || confirmed) return
    setError(null)
    const result = await onConfirm()
    if (!result.ok) setError({ text: failureText(result.failure), retry: retryable(result.failure) })
  }

  return (
    <Section title={addedFactsCopy.lift.title} headingProps={{ id: "added-facts-lift-heading" }}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <p className="text-sm tabular-nums">{addedFactsCopy.match.profile(match.posting.covered, match.posting.total)}</p>
          <p className="text-sm tabular-nums">{addedFactsCopy.match.withAdded(match.withAdded.covered, match.withAdded.total)}</p>
        </div>
        {match.covers.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium text-muted-foreground">{addedFactsCopy.lift.coversHeading}</h3>
            <ul className="flex flex-col gap-1.5 text-sm">
              {match.covers.map((cover) => {
                const fact = facts.find((candidate) => candidate.id === cover.factId)
                return (
                  <li key={`${cover.factId}-${cover.requirement}`} className="flex flex-wrap items-baseline gap-x-1.5 [overflow-wrap:anywhere]">
                    {fact !== undefined && <span className="font-medium">{fact.text}</span>}
                    {fact !== undefined && <span aria-hidden="true">→</span>}
                    <span className="min-w-0">{cover.requirement}</span>
                    {cover.kind === "skill_only" && (
                      <span className="text-[13px] text-muted-foreground">
                        (<span>{addedFactsCopy.match.skillOnly}</span>)
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        {showOverrideNote && <p className="text-[13px] text-muted-foreground text-pretty">{addedFactsCopy.match.overrideNote}</p>}
        {confirmed ? (
          <p className="flex items-start gap-1.5 text-sm">
            <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success-text" />
            <span>{addedFactsCopy.lift.confirmed}</span>
          </p>
        ) : (
          <>
            {voided && (
              <p className="flex items-start gap-1.5 text-[13px] text-warning-text">
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span className="[overflow-wrap:anywhere]">{addedFactsCopy.lift.voided}</span>
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                className="pointer-coarse:min-h-11"
                disabled={waiting || isConfirming}
                focusableWhenDisabled
                aria-describedby={waiting ? reasonId : undefined}
                onClick={() => void confirm()}
              >
                {isConfirming ? addedFactsCopy.lift.pending : addedFactsCopy.lift.action}
              </Button>
            </div>
            {waiting ? (
              <p id={reasonId} className="text-[13px] text-muted-foreground">
                {addedFactsCopy.lift.staleReason}
              </p>
            ) : (
              !voided && <p className="text-[13px] text-muted-foreground">{addedFactsCopy.lift.helper}</p>
            )}
            {error !== null && (
              <p role="alert" className="flex items-start gap-1.5 text-[13px] text-destructive-text">
                <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span className="flex min-w-0 flex-col items-start gap-1">
                  <span className="[overflow-wrap:anywhere]">{error.text}</span>
                  {error.retry && (
                    <Button type="button" variant="outline" size="sm" onClick={() => void confirm()} disabled={isConfirming} focusableWhenDisabled>
                      {addedFactsCopy.errors.tryAgain}
                    </Button>
                  )}
                </span>
              </p>
            )}
          </>
        )}
      </div>
    </Section>
  )
}

function failureText(failure: AddedFactsFailure): string {
  switch (failure.kind) {
    case "stale":
      return addedFactsCopy.lift.staleReason
    case "conflict":
      return addedFactsCopy.errors.conflict
    case "frozen":
      return addedFactsCopy.errors.frozen
    case "busy":
      return addedFactsCopy.errors.busy
    default:
      return addedFactsCopy.errors.network
  }
}

/** C-AF-58 is the only slot with a "Try again" button; every other refusal has its own recovery. */
function retryable(failure: AddedFactsFailure): boolean {
  return failure.kind === "network"
}
