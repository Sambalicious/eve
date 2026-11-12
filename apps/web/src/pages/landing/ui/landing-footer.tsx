import { Link } from "react-router-dom"

import { Wordmark } from "@/shared/ui/logo"
import { landingCopy } from "../model/copy"

/**
 * Closed letter outlines for "EVE" on a 1120 × 336 box (design-spec r1 2.3).
 * Geometry only, drawn as a 1px hairline; never filled.
 */
const E = (x: number) =>
  `M${x} 16H${x + 272}V80H${x + 72}V136H${x + 240}V200H${x + 72}V256H${x + 272}V320H${x}Z`
const V = (x: number) => `M${x} 16H${x + 80}L${x + 172} 238L${x + 264} 16H${x + 344}L${x + 212} 320H${x + 132}Z`
const OUTLINE = `${E(64)} ${V(388)} ${E(784)}`

/** Footer: wordmark, Privacy, and the decorative outline wordmark (AC 1.7). */
export function LandingFooter() {
  return (
    <footer className="landing-footer">
      <div className="landing-container landing-ruled">
        <div className="flex items-center justify-between gap-4">
          <Link to="/" aria-label={landingCopy.a11y.homeLink} className="landing-link -m-1 rounded-sm p-1">
            <Wordmark className="text-foreground" />
          </Link>
          <Link to="/privacy" className="landing-link landing-quiet-link rounded-sm text-sm">
            {landingCopy.footer.privacy}
          </Link>
        </div>
        <svg
          className="landing-outline-wordmark"
          width="1120"
          height="336"
          viewBox="0 0 1120 336"
          aria-hidden="true"
          focusable="false"
        >
          <path d={OUTLINE} fill="none" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
    </footer>
  )
}
