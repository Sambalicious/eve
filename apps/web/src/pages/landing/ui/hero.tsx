import type { ReactNode, RefObject } from "react"
import { ArrowDown } from "lucide-react"

import { ButtonLink } from "@/shared/ui/button-link"
import { landingCopy } from "../model/copy"

const c = landingCopy.hero

interface HeroProps {
  signedIn: boolean
  onAccessLink: (event: React.MouseEvent<HTMLAnchorElement>) => void
  /** The product frame, below the hero text. */
  frame: ReactNode
  /** The hero section, for fragment drift and parallax. */
  heroRef?: RefObject<HTMLElement | null>
}

/**
 * The hero: headline (LCP, never animated), subhead, one filled action, the
 * access jump and the invite note, then the frame. Left-aligned below 768px,
 * centred from 768px (design-spec r1 2.3 to 2.5).
 */
export function Hero({ signedIn, onAccessLink, frame, heroRef }: HeroProps) {
  return (
    <section ref={heroRef} aria-labelledby="hero-title" className="landing-hero">
      <div className="landing-container">
        <div className="landing-hero-text">
          <h1 id="hero-title" className="landing-h1">
            {`${c.headlineLines[0]} `}
            <span className="landing-h1-ink">{c.headlineLines[1]}</span>
          </h1>
          <p className="landing-subhead">{c.subhead}</p>
          <div className="landing-hero-actions">
            <ButtonLink
              to={signedIn ? "/dashboard" : "/sign-in"}
              className="landing-primary max-md:h-11 max-md:w-full pointer-coarse:h-11"
            >
              {signedIn ? c.ctaDashboard : c.cta}
            </ButtonLink>
            <a href="#access" onClick={onAccessLink} className="landing-link landing-hero-jump">
              {c.accessLink}
              <ArrowDown aria-hidden="true" className="landing-jump-arrow size-3.5" />
            </a>
          </div>
          <p className="landing-note">{c.note}</p>
        </div>
        {frame}
      </div>
    </section>
  )
}
