import type { CSSProperties, ReactNode } from "react"
import { BadgeCheck, CircleCheck } from "lucide-react"

import { landingCopy } from "../../model/copy"

const ns = { vectorEffect: "non-scaling-stroke" } as const

/** Three rising bars, the Match meter (cobalt, not green: Match isn't a success state). */
function Meter() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" focusable="false" className="hero-chip-icon hero-chip-meter">
      <rect x="1" y="8" width="4" height="8" rx="1" />
      <rect x="6" y="4" width="4" height="12" rx="1" />
      <rect x="11" y="0" width="4" height="16" rx="1" />
    </svg>
  )
}

/** F4: an envelope with an unread azure dot. No text. */
function Envelope() {
  return (
    <svg viewBox="0 0 72 56" focusable="false" fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="hero-envelope">
      <rect x="4" y="8" width="64" height="44" rx="6" className="p s" {...ns} />
      <path d="M6 12l30 20 30-20" className="s" {...ns} />
      <circle cx="62" cy="10" r="5" className="af" />
    </svg>
  )
}

interface FragmentProps {
  n: 1 | 2 | 3 | 4
  children: ReactNode
}

/**
 * Three nested layers so the three motions never fight over `transform`:
 * the outer box takes the scroll parallax, the middle the idle drift, the
 * card the entrance (planned with the frame's timeline).
 */
function Fragment({ n, children }: FragmentProps) {
  return (
    <div className={`hero-frag hero-frag-${n}`} style={{ "--n": n } as CSSProperties}>
      <div className="hero-frag-drift">
        <div className="hero-frag-card" data-fragment={n}>
          {children}
        </div>
      </div>
    </div>
  )
}

interface HeroFragmentsProps {
  labels?: { eligibility: string; match: string; confirmed: string }
}

const DEFAULT_LABELS = {
  eligibility: landingCopy.hero.fragmentEligibility,
  match: landingCopy.frame.matchBadge,
  confirmed: landingCopy.frame.statusConfirmed,
}

/**
 * I-HERO layer 2 (design-spec r3): four decorative fragments around the
 * product frame that echo its story. Hidden from assistive tech and from the
 * pointer. Which ones show depends on the width (CSS). A fragment whose
 * label is empty is not rendered at all.
 */
export function HeroFragments({ labels = DEFAULT_LABELS }: HeroFragmentsProps) {
  return (
    <div className="hero-frags" aria-hidden="true">
      {labels.eligibility ? (
        <Fragment n={1}>
          <span className="hero-chip">
            <CircleCheck aria-hidden="true" className="hero-chip-icon hero-chip-success" />
            <span className="hero-chip-label">{labels.eligibility}</span>
          </span>
        </Fragment>
      ) : null}
      {labels.match ? (
        <Fragment n={2}>
          <span className="hero-chip">
            <Meter />
            <span className="hero-chip-label">{labels.match}</span>
          </span>
        </Fragment>
      ) : null}
      {labels.confirmed ? (
        <Fragment n={3}>
          <span className="hero-chip hero-stamp">
            <BadgeCheck aria-hidden="true" className="hero-chip-icon" />
            <span className="hero-chip-label">{labels.confirmed}</span>
          </span>
        </Fragment>
      ) : null}
      <Fragment n={4}>
        <Envelope />
      </Fragment>
    </div>
  )
}
