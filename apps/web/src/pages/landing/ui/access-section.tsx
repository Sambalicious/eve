import type { CSSProperties, ReactNode } from "react"
import { Link } from "react-router-dom"

import { ButtonLink } from "@/shared/ui/button-link"
import { landingCopy } from "../model/copy"

const c = landingCopy.access
const i = (index: number) => ({ "--i": index }) as CSSProperties

interface AccessSectionProps {
  signedIn: boolean
  /** The Request access button and its dialog (design-spec r2 S1 item 11). */
  requestAccess: ReactNode
}

/**
 * Section 6, "How access works": invite-only, no sign-up, the request row,
 * the signed-invite line, the data line and the closing filled button. The
 * heading is the in-page jump's focus target.
 */
export function AccessSection({ signedIn, requestAccess }: AccessSectionProps) {
  return (
    <section id="access" aria-labelledby="access-title" data-reveal="access" data-ground="tint" className="landing-section">
      <div className="landing-container landing-ruled">
        <div className="landing-access reveal-item" style={i(0)}>
          <h2 id="access-title" tabIndex={-1} className="landing-h2 landing-focus-target">
            {c.title}
          </h2>
          <p className="landing-para">{c.invite}</p>
          <p className="landing-para">{c.noSignup}</p>
          <div className="landing-request-row">
            <p className="landing-para">{c.requestNote}</p>
            {requestAccess}
          </div>
          <p className="landing-para landing-signed-invite">{c.signedInvite}</p>
        </div>
        <p className="landing-note landing-data-line reveal-item" style={i(1)}>
          {c.dataLine.before}
          <Link to="/privacy" className="landing-link landing-inline-link">
            {c.privacyLink}
          </Link>
          {c.dataLine.after}
        </p>
        <div className="landing-access-cta reveal-item" style={i(2)}>
          <ButtonLink
            to={signedIn ? "/dashboard" : "/sign-in"}
            className="landing-primary max-md:h-11 max-md:w-full pointer-coarse:h-11"
          >
            {signedIn ? c.ctaDashboard : c.cta}
          </ButtonLink>
        </div>
      </div>
    </section>
  )
}
