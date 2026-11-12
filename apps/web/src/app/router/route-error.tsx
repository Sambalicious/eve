import { useEffect } from "react"
import { isRouteErrorResponse, useRouteError } from "react-router-dom"

import { claimChunkReload, isChunkLoadError } from "./chunk-reload"
import { PageLoadError } from "./page-load-error"

function reload() {
  window.location.reload()
}

/** Decided once per error, so StrictMode's second render keeps the same answer. */
const reloadDecisions = new WeakMap<object, boolean>()

function shouldAutoReload(error: unknown): boolean {
  if (!isChunkLoadError(error)) return false
  const key = error as object
  let decision = reloadDecisions.get(key)
  if (decision === undefined) {
    decision = claimChunkReload(window.sessionStorage)
    reloadDecisions.set(key, decision)
  }
  return decision
}

/**
 * Root error boundary for the router. Replaces React Router's developer
 * screen with C-ERR-1. A failed page chunk reloads the page once first.
 */
export function RouteError({ onReload = reload }: { onReload?: () => void }) {
  const error = useRouteError()
  const autoReload = shouldAutoReload(error)

  useEffect(() => {
    if (autoReload) onReload()
  }, [autoReload, onReload])

  useEffect(() => {
    if (!isRouteErrorResponse(error)) console.error(error)
  }, [error])

  if (autoReload)
    return <div className="min-h-svh bg-sidebar" aria-hidden="true" />
  return <PageLoadError onRetry={onReload} />
}
