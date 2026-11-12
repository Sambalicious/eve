import { lazy, Suspense } from "react"
import { Outlet, useLocation, useNavigation } from "react-router-dom"

import { loadShellFallback } from "./shell-fallback-loader"

const ShellFallback = lazy(async () => ({ default: (await loadShellFallback()).ShellFallback }))

/** Thin top bar shown while the next route's code is loading. */
function RouteProgress() {
  return (
    <div
      role="progressbar"
      aria-label="Loading page"
      className="route-progress fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden bg-primary/15"
    >
      <div className="route-progress-bar h-full w-1/3 bg-primary" />
    </div>
  )
}

export function RootLayout() {
  const navigation = useNavigation()
  return (
    <>
      {navigation.state === "loading" && <RouteProgress />}
      <Outlet />
    </>
  )
}

/**
 * Shown on the very first load, before the session is confirmed or the page
 * code has arrived: the app shell with the requested page's skeleton, so the
 * layout doesn't move when the page renders. Paths without a page skeleton
 * (sign-in, error pages) show a blank page in the sign-in background; the
 * public landing page shows a blank page in its own background.
 */
export function RootFallback() {
  const { pathname } = useLocation()
  return <RouteFallback pathname={pathname} />
}

/** Same fallback while the first route's code loads (the router's HydrateFallback). */
export const HydrateFallback = RootFallback

/**
 * The skeleton is `inert`: its navigation can't be focused or clicked and
 * assistive tech skips it, as it skipped the spinner. Only "Loading…" is read.
 * The landing page gets a blank page in its own background and never loads
 * the shell chunk.
 */
function RouteFallback({ pathname }: { pathname: string }) {
  if (pathname === "/" || pathname === "/about") return <div className="min-h-svh bg-background" aria-hidden="true" />
  return (
    <>
      <p className="sr-only">Loading…</p>
      <Suspense fallback={<div className="min-h-svh bg-sidebar" aria-hidden="true" />}>
        <ShellFallback pathname={pathname} />
      </Suspense>
    </>
  )
}
