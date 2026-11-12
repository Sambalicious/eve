import { Link } from "react-router-dom"

import type { TailoredDocument } from "@/entities/application"

type Ats = NonNullable<TailoredDocument["ats"]>

/**
 * ATS match of a tailored resume (owner decision 2026-11-01: ATS scoring is the heart of Eve). Shows the
 * score, the posting's keywords this resume uses, those the profile has but the resume doesn't, and the
 * real gaps, which only a new Career Profile fact can close.
 */
export function AtsScoreCard({ ats }: { ats: Ats }) {
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
      {ats.matched.length > 0 && <KeywordLine label="In this resume" items={ats.matched} />}
      {ats.missing.length > 0 && <KeywordLine label="In your profile, not in this resume" items={ats.missing} />}
      {ats.gaps.length > 0 && (
        <>
          <KeywordLine label="Not in your profile" items={ats.gaps} />
          <p className="text-muted-foreground">
            Eve never claims what your profile doesn't state. If you have this experience,{" "}
            <Link to="/profile" className="underline underline-offset-2">
              add it to your Career Profile
            </Link>{" "}
            and generate again.
          </p>
        </>
      )}
    </section>
  )
}

function KeywordLine({ label, items }: { label: string; items: readonly string[] }) {
  return (
    <p className="[overflow-wrap:anywhere]">
      <span className="text-muted-foreground">{label}:</span> {items.join(", ")}
    </p>
  )
}
