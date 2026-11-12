import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@fontsource-variable/geist"
import "@fontsource-variable/bricolage-grotesque/opsz.css"
import "./styles/index.css"
import { App } from "./app"
import { createApp } from "./create-app"
import { loadShellFallback } from "./router/shell-fallback-loader"

declare global {
  interface Window {
    /** Set once the app rendered; the boot script's 3 s fail-safe checks it. */
    __eveReady?: boolean
  }
}

const container = document.getElementById("root")!
const app = createApp()

// App paths show the shell skeleton first; start its chunk with the entry. The landing page never needs it.
if (window.location.pathname !== "/" && window.location.pathname !== "/about") void loadShellFallback()

/**
 * On a prerendered `/` or `/about` the static markup stays on screen until the
 * landing route's code has loaded, then React replaces it with the identical
 * tree in one commit, so there is no blank frame (architecture r1 section 1).
 */
function whenRouteReady(): Promise<void> {
  if (container.dataset.prerendered !== window.location.pathname || app.router.state.initialized) return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = app.router.subscribe((state) => {
      if (!state.initialized) return
      unsubscribe()
      resolve()
    })
  })
}

void whenRouteReady().then(() => {
  createRoot(container).render(
    <StrictMode>
      <App app={app} />
    </StrictMode>
  )
  window.__eveReady = true
})
