import { CircleAlert, Link2 } from "lucide-react"
import { useEffect, useId, useState, type MouseEvent } from "react"
import { Link } from "react-router-dom"

import type { AddedFactsView } from "@eve/contracts"

import type { TailoredDocument } from "@/entities/application"
import { atsAddedCopy, addedFactsCopy, type AddedFactsFailure } from "@/features/added-facts"
import { Button } from "@/shared/ui/button"
import { Checkbox } from "@/shared/ui/checkbox"

type Ats = NonNullable<TailoredDocument["ats"]>

/** What the tick save answers: how many facts were stored, or why not (mapped to C-AF-51, 52, 57, 58). */
export type TickSaveOutcome = Readonly<{ ok: true; added: number }> | Readonly<{ ok: false; failure: AddedFactsFailure }>

export type AtsAddedFactsProps = Readonly<{
  view: AddedFactsView
  /** One request with every ticked term, all or nothing (api-contract `POST …/added-facts`). */
  onSaveTicks: (items: readonly { term: string; saveToProfile: boolean }[]) => Promise<TickSaveOutcome>
  /** The page's one live region, in the Added section. Also speaks the tick count and the save result. */
  announce: (text: string) => void
}>

/**
 * ATS match of a tailored resume (owner decision 2026-11-01: ATS scoring is the heart of Eve). With
 * FEAT-0017's view (`addedFacts` present) "Not in your profile" becomes the tick list of the live gap
 * terms (design-spec.r1 blueprint 1): a shared Affirmation, a per-term "Also add to my Career Profile"
 * box, and an "Add {n} skills to this job" bar. Without the view the card is exactly as it was.
 */
export function AtsScoreCard({ ats, addedFacts }: { ats: Ats; addedFacts?: AtsAddedFactsProps }) {
  const met = ats.total - ats.missing.length - ats.gaps.length
  return (
    <section aria-labelledby="ats-score-title" className="flex flex-col gap-2 rounded-xl border p-4 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 id="ats-score-title" className="text-base font-semibold">
          ATS match {ats.score}%
        </h4>
        <span className="text-muted-foreground">
          {met} of {ats.total} requirements from this posting
        </span>
      </div>
      {/* C-AF-15 sits directly under the score (design-spec.r1 blueprint 1), above the keyword lines. */}
      {addedFacts !== undefined && addedFacts.view.documentsStale && (
        <p className="text-[13px] text-muted-foreground">{atsAddedCopy.stale}</p>
      )}
      {ats.matched.length > 0 && <KeywordLine label="In this resume" items={ats.matched} />}
      {ats.missing.length > 0 && <KeywordLine label="In your profile, not in this resume" items={ats.missing} />}
      {addedFacts === undefined ? <GapsLine ats={ats} /> : <AddedGaps {...addedFacts} />}
    </section>
  )
}

/** Today's card, unchanged: the gaps as a comma list and the link to the Career Profile. */
function GapsLine({ ats }: { ats: Ats }) {
  if (ats.gaps.length === 0) return null
  return (
    <>
      <KeywordLine label={atsAddedCopy.gapsLabel} items={ats.gaps} />
      <ProfileLinkLine />
    </>
  )
}

function AddedGaps({ view, onSaveTicks, announce }: AtsAddedFactsProps) {
  const hintId = useId()
  const affirmationId = useId()
  const profileTermId = useId()
  const [ticked, setTicked] = useState<readonly string[]>([])
  const [profileChoices, setProfileChoices] = useState<readonly string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<Readonly<{ text: string; retry: boolean }> | null>(null)

  const terms = view.postingGaps.available ? view.postingGaps.terms : []
  const chosen = terms.filter((term) => ticked.includes(term))
  const skillOnlyFacts = view.facts.filter((fact) => fact.kind === "skill_only")
  const busy = view.busyReason !== null

  // C-AF-73: the count after 600 ms of no change. One live region, owned by the page.
  useEffect(() => {
    if (chosen.length === 0) return
    const timer = window.setTimeout(
      () => announce(chosen.length === 1 ? atsAddedCopy.tickedOne(chosen.length) : atsAddedCopy.tickedOther(chosen.length)),
      600
    )
    return () => window.clearTimeout(timer)
  }, [chosen.length, announce])

  async function save() {
    if (saving || chosen.length === 0) return
    setSaving(true)
    setError(null)
    const outcome = await onSaveTicks(chosen.map((term) => ({ term, saveToProfile: profileChoices.includes(term) })))
    setSaving(false)
    if (outcome.ok) {
      setTicked([])
      setProfileChoices([])
      announce(outcome.added === 1 ? atsAddedCopy.addedOne(outcome.added) : atsAddedCopy.addedOther(outcome.added))
      return
    }
    setError(tickErrorMessage(outcome.failure))
  }

  function toggle(term: string, checked: boolean) {
    setTicked((current) => (checked ? [...current.filter((value) => value !== term), term] : current.filter((value) => value !== term)))
    if (!checked) setProfileChoices((current) => current.filter((value) => value !== term))
  }

  function toggleProfile(term: string, checked: boolean) {
    setProfileChoices((current) => (checked ? [...current.filter((value) => value !== term), term] : current.filter((value) => value !== term)))
  }

  const showsList = terms.length > 0
  return (
    <div className="flex flex-col gap-2.5 border-t pt-3">
      {showsList ? (
        <>
          <p className="text-[13px] font-medium">
            {atsAddedCopy.gapsLabel} <span className="font-normal text-muted-foreground">· {terms.length}</span>
          </p>
          {view.editable ? (
            <>
              <p id={hintId}>{atsAddedCopy.hint}</p>
              <p id={affirmationId} className="text-[13px] text-muted-foreground">
                {atsAddedCopy.affirmation}
              </p>
              <fieldset aria-describedby={`${hintId} ${affirmationId}`} className="m-0 min-w-0 border-0 p-0">
                <legend className="sr-only">{atsAddedCopy.groupLabel}</legend>
                <div className="flex flex-col sm:block sm:columns-2 sm:gap-x-6">
                  {terms.map((term, index) => {
                    const checked = chosen.includes(term)
                    const profileTermDescriptionId = `${profileTermId}-${index}`
                    return (
                      <div key={term} className="break-inside-avoid border-b border-border/60 last:border-b-0">
                        <label className="flex min-h-11 cursor-pointer items-start gap-2.5 py-2 pointer-coarse:items-center">
                          {/* C-AF-74 on the box itself: the label's inline boxes would join with a space ("Figma , I have used this"). */}
                          <Checkbox className="mt-0.5 pointer-coarse:mt-0" checked={checked} aria-label={`${term}${atsAddedCopy.tickName}`} onCheckedChange={(value) => toggle(term, value)} />
                          <span className="min-w-0 [overflow-wrap:anywhere]">
                            <bdi>{term}</bdi>
                          </span>
                        </label>
                        {checked && (
                          <>
                            {/* C-AF-7 r2: name is the visible label C-AF-6 exactly; the term is the description. The
                                describedby node must sit outside the label, or its text would join the name. */}
                            <label className="mb-2 flex cursor-pointer items-start gap-2.5 pl-6 text-[13px] text-muted-foreground">
                              <Checkbox
                                className="mt-0.5"
                                checked={profileChoices.includes(term)}
                                aria-describedby={profileTermDescriptionId}
                                onCheckedChange={(value) => toggleProfile(term, value)}
                              />
                              <span className="min-w-0 [overflow-wrap:anywhere]">{atsAddedCopy.saveToProfile}</span>
                            </label>
                            <span id={profileTermDescriptionId} className="sr-only">
                              {atsAddedCopy.profileDescription(term)}
                            </span>
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>
              </fieldset>
              {error !== null && (
                <p role="alert" className="flex items-start gap-1.5 text-[13px] text-destructive-text">
                  <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span className="flex min-w-0 flex-col items-start gap-1">
                    <span className="[overflow-wrap:anywhere]">{error.text}</span>
                    {error.retry && (
                      <Button type="button" variant="outline" size="sm" onClick={() => void save()} disabled={saving} focusableWhenDisabled>
                        {addedFactsCopy.errors.tryAgain}
                      </Button>
                    )}
                  </span>
                </p>
              )}
              {chosen.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => void save()} disabled={saving} focusableWhenDisabled>
                    {saving ? addedFactsCopy.form.saving : atsAddedCopy.add(chosen.length)}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => { setTicked([]); setProfileChoices([]); setError(null) }}>
                    {atsAddedCopy.clear}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <>
              <ul role="list" className="flex flex-col gap-1">
                {terms.map((term) => (
                  <li key={term} className="min-h-8 py-1 [overflow-wrap:anywhere]">
                    <bdi>{term}</bdi>
                  </li>
                ))}
              </ul>
              <p className="text-[13px] text-muted-foreground">{busy ? atsAddedCopy.busy : atsAddedCopy.frozen}</p>
            </>
          )}
          <ProfileLinkLine />
        </>
      ) : (
        skillOnlyFacts.length > 0 && <p className="text-muted-foreground">{atsAddedCopy.allAdded}</p>
      )}
      {view.facts.length > 0 && <AddedSummary view={view} />}
    </div>
  )
}

/** C-AF-10 / C-AF-11 / C-AF-12: one line, first five, then "and {n} more". */
function AddedSummary({ view }: { view: AddedFactsView }) {
  const labels = view.facts.map((fact) => fact.term ?? fact.text)
  const first = labels.slice(0, 5)
  const more = labels.length - first.length
  function focusSection(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault()
    document.getElementById("added-facts")?.scrollIntoView?.({ block: "start" })
    document.getElementById("added-facts-heading")?.focus()
  }
  return (
    <p className="flex flex-wrap items-baseline gap-x-1.5 text-[13px] [overflow-wrap:anywhere]">
      <span>
        {atsAddedCopy.summary(first.join(", "))}
        {more > 0 && ` ${atsAddedCopy.summaryMore(more)}`}
      </span>
      <Link to="#added-facts" className="inline-flex items-center gap-1 underline underline-offset-2" onClick={focusSection}>
        <Link2 aria-hidden="true" className="size-3.5" />
        {atsAddedCopy.manage}
      </Link>
    </p>
  )
}

function ProfileLinkLine() {
  return (
    <p className="text-muted-foreground">
      Eve never claims what your profile doesn't state. If you have this experience,{" "}
      <Link to="/profile" className="underline underline-offset-2">
        add it to your Career Profile
      </Link>{" "}
      and generate again.
    </p>
  )
}

function tickErrorMessage(failure: AddedFactsFailure): Readonly<{ text: string; retry: boolean }> {
  if (failure.kind === "fields") {
    const problems = failure.fieldErrors.map((field) => field.problem)
    if (problems.includes("skill_only_limit")) return { text: addedFactsCopy.errors.skillCeiling, retry: false }
    if (problems.includes("one_liner_limit")) return { text: addedFactsCopy.errors.oneLinerLimit, retry: false }
    if (problems.includes("term_not_a_gap")) return { text: addedFactsCopy.errors.termNotInList, retry: false }
    if (problems.includes("affirmation_required")) return { text: addedFactsCopy.errors.affirm, retry: false }
    return { text: addedFactsCopy.errors.network, retry: true }
  }
  switch (failure.kind) {
    case "conflict":
      return { text: addedFactsCopy.errors.conflict, retry: false }
    case "frozen":
      return { text: addedFactsCopy.errors.frozen, retry: false }
    case "busy":
      return { text: addedFactsCopy.errors.busy, retry: false }
    default:
      return { text: addedFactsCopy.errors.network, retry: true }
  }
}

function KeywordLine({ label, items }: { label: string; items: readonly string[] }) {
  return (
    <p className="[overflow-wrap:anywhere]">
      <span className="text-muted-foreground">{label}:</span> {items.join(", ")}
    </p>
  )
}
