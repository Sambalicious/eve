import { render } from "@testing-library/react"
import { createMemoryRouter } from "react-router-dom"

import { App } from "../app"
import { createApp } from "../create-app"
import { preloadPages } from "../router/routes"

// Each test file runs in a fresh module graph, so the first navigation to a
// lazy route evaluates that page and its UI dependencies (Base UI dialog and
// menu, the sidebar) inside the first test's timeout. Under CPU contention
// that took 5-9 s. Loading the pages while this module is imported moves the
// cost to Vitest's import phase; routes still resolve through `lazy`.
await preloadPages()

/** Renders the whole app, with its real routes and providers, at `initialPath`. */
export function renderApp(initialPath: string) {
  const app = createApp((routes) =>
    createMemoryRouter(routes, { initialEntries: [initialPath] })
  )
  const view = render(<App app={app} />)
  return { ...view, app, currentPath: () => currentPath(app) }
}

function currentPath({ router }: ReturnType<typeof createApp>): string {
  const { pathname, search, hash } = router.state.location
  return `${pathname}${search}${hash}`
}
