import { renderToString } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"

import { LandingContent, landingHead } from "@/pages/landing"

export type PrerenderPath = "/" | "/about"

/**
 * SSR entry for the build-time prerender (architecture r1 section 5). Renders
 * the signed-out landing page inside the same wrapper `div` as `App`, so the
 * client's first render matches. `scripts/prerender.mjs` writes it into the
 * built HTML. No providers are needed: `LandingContent` reads no query.
 */
export function renderLanding(path: PrerenderPath, publicOrigin: string | undefined) {
  const body = renderToString(
    <div className="font-sans antialiased">
      <MemoryRouter initialEntries={[path]}>
        <LandingContent path={path} signedIn={false} />
      </MemoryRouter>
    </div>
  )
  return { body, head: landingHead(path, publicOrigin) }
}
