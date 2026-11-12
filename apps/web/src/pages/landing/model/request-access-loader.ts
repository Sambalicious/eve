import type { ComponentType } from "react"

import type { RequestAccessFormProps } from "@/features/request-access"

type FormModule = { RequestAccessForm: ComponentType<RequestAccessFormProps> }
type ImportStatic = () => Promise<FormModule>
type ImportUrl = (url: string) => Promise<FormModule>

/** The chunk URL named in a failed dynamic import (Chromium and Firefox), if it is same-origin. */
function failedChunkUrl(error: unknown): string | null {
  const match = /(https?:\/\/[^\s"']+\.js)/.exec(error instanceof Error ? error.message : "")
  if (!match) return null
  const url = new URL(match[1])
  return url.origin === window.location.origin ? `${url.origin}${url.pathname}` : null
}

/**
 * Loads the form chunk once and shares the promise between hover, focus and
 * press (architecture r1 8.1). A browser keeps a failed module fetch in its
 * module map, so re-importing the same specifier rejects without a new
 * request (F-QA-E3-02). After a failure the next call imports the named chunk
 * under a fresh `?retry=N` URL; when the error names no URL (Safari), it falls
 * back to the static import.
 */
export function createChunkLoader(importStatic: ImportStatic, importUrl: ImportUrl): () => Promise<FormModule> {
  let pending: Promise<FormModule> | null = null
  let failedUrl: string | null = null
  let retries = 0
  return () => {
    if (pending) return pending
    const attempt = failedUrl ? importUrl(`${failedUrl}?retry=${++retries}`) : importStatic()
    pending = attempt.catch((error: unknown) => {
      pending = null
      failedUrl = failedChunkUrl(error) ?? failedUrl
      throw error
    })
    return pending
  }
}

/** Called only from event handlers, never on load or idle. */
export const loadRequestAccessForm = createChunkLoader(
  () => import("@/features/request-access"),
  (url) => import(/* @vite-ignore */ url) as Promise<FormModule>
)
