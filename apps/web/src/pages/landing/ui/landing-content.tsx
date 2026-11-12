import { useCallback, useRef } from "react"

import { PublicHeader } from "@/components/public-header"
import { landingCopy } from "../model/copy"
import { revealThrough } from "../model/reveal"
import { useFragmentDrift } from "../model/use-fragment-drift"
import { useHeroPlayer } from "../model/use-hero-player"
import { useSectionReveal } from "../model/use-section-reveal"
import { AccessSection } from "./access-section"
import { LimitsSection, StepsSection, StopsSection } from "./content-sections"
import { Hero } from "./hero"
import { HeroFrame } from "./hero-frame"
import { LandingFooter } from "./landing-footer"
import { RequestAccess } from "./request-access"

export interface LandingContentProps {
  /** `/about` keeps its URL; both render the same page (F8). */
  path: "/" | "/about"
  /** Session confirmed: the three Sign in controls read "Open dashboard". */
  signedIn: boolean
}

const headerLabels = {
  homeLink: landingCopy.a11y.homeLink,
  nav: landingCopy.a11y.headerNav,
  accessLink: landingCopy.header.accessLink,
  signIn: landingCopy.header.signIn,
  dashboard: landingCopy.header.dashboard,
}

/**
 * The landing page tree. Pure: no query and no `window` during render, so the
 * build prerenders exactly this markup (architecture r1 section 5). Motion and
 * reveals attach in effects after hydration.
 */
export function LandingContent({ signedIn }: LandingContentProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const demoRef = useRef<HTMLDivElement>(null)
  const heroRef = useRef<HTMLElement>(null)
  const { replayHidden, replay } = useHeroPlayer({ frameRef, demoRef })
  useFragmentDrift({ heroRef, frameRef, demoRef })
  useSectionReveal(rootRef)

  const jumpToAccess = useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
    const root = rootRef.current
    const target = root?.querySelector<HTMLElement>("#access")
    if (!root || !target) return
    event.preventDefault()
    revealThrough(root, target)
    target.scrollIntoView?.({ block: "start" })
    root.querySelector<HTMLElement>("#access-title")?.focus({ preventScroll: true })
    if (window.location.hash !== "#access") history.replaceState(history.state, "", "#access")
  }, [])

  return (
    <div ref={rootRef} data-landing-root className="landing landing-root min-h-svh bg-background text-foreground">
      <a href="#main" className="landing-skip">
        {landingCopy.skip.link}
      </a>
      <PublicHeader labels={headerLabels} cta={signedIn ? "dashboard" : "sign-in"} onAccessLink={jumpToAccess} />
      <main id="main" tabIndex={-1} className="landing-main">
        <Hero
          heroRef={heroRef}
          signedIn={signedIn}
          onAccessLink={jumpToAccess}
          frame={<HeroFrame frameRef={frameRef} demoRef={demoRef} replayHidden={replayHidden} onReplay={replay} />}
        />
        <StepsSection />
        <StopsSection />
        <LimitsSection />
        <AccessSection signedIn={signedIn} requestAccess={<RequestAccess />} />
      </main>
      <LandingFooter />
    </div>
  )
}
