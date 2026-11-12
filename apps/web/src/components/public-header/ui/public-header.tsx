import { Link } from "react-router-dom"

import { ButtonLink } from "@/shared/ui/button-link"
import { Wordmark } from "@/shared/ui/logo"

export interface PublicHeaderLabels {
  homeLink: string
  nav: string
  accessLink: string
  signIn: string
  dashboard: string
}

interface PublicHeaderProps {
  labels: PublicHeaderLabels
  /** `dashboard` on `/about` with a session (landing.header.dashboard). */
  cta: "sign-in" | "dashboard"
  /** The "How access works" jump; the page marks sections revealed and moves focus. */
  onAccessLink?: (event: React.MouseEvent<HTMLAnchorElement>) => void
}

/**
 * Public header (design-spec r1 2.2, shared with the signed-out Privacy page):
 * wordmark, one text link, one outline button. Sticky and translucent, with
 * the app header's scroll edge. Never a filled button (AC 1.3).
 *
 * The row is 56 px at the default text size. When enlarged text no longer fits
 * one row (375 px at 200 %, B4), the nav wraps under the wordmark and the link
 * above the button instead of overflowing; nothing moves at default sizes.
 */
export function PublicHeader({ labels, cta, onAccessLink }: PublicHeaderProps) {
  return (
    <header className="public-header sticky top-0 z-10 border-b">
      <div className="public-header-row mx-auto flex min-h-14 max-w-[1120px] flex-wrap items-center justify-between gap-x-2 gap-y-1 px-4 py-2 lg:px-6">
        <Link to="/" aria-label={labels.homeLink} className="landing-link -m-1 rounded-sm p-1">
          <Wordmark className="text-foreground" />
        </Link>
        <nav aria-label={labels.nav} className="public-header-nav ms-auto flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1 md:gap-x-4">
          <a
            href="#access"
            onClick={onAccessLink}
            className="landing-link landing-quiet-link rounded-sm text-sm font-medium max-[359px]:hidden"
          >
            {labels.accessLink}
          </a>
          {cta === "dashboard" ? (
            <ButtonLink to="/dashboard" variant="outline">
              {labels.dashboard}
            </ButtonLink>
          ) : (
            <ButtonLink to="/sign-in" variant="outline">
              {labels.signIn}
            </ButtonLink>
          )}
        </nav>
      </div>
    </header>
  )
}
