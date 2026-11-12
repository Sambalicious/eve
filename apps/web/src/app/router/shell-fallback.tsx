import { AppShellSkeleton } from "@/components/app-shell"
import { routeSkeleton } from "@/components/page-skeletons"

/**
 * The app shell with the requested page's skeleton. Its own chunk, so the
 * public landing page's first load never downloads the shell (EPIC-0003
 * architecture r1, "400 KB first-load cap": lazy-load `AppShellSkeleton` out
 * of the entry). `main.tsx` starts loading it at boot on app paths.
 */
export function ShellFallback({ pathname }: { pathname: string }) {
  const skeleton = routeSkeleton(pathname)
  if (!skeleton) return <div className="min-h-svh bg-sidebar" aria-hidden="true" />
  return (
    <div inert aria-hidden="true">
      <AppShellSkeleton title={skeleton.title} description={skeleton.description}>
        {skeleton.content}
      </AppShellSkeleton>
    </div>
  )
}
