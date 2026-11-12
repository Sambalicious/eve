import { useEffect } from "react"

/** Sets `document.title` to "{Page title} · Eve" (design-spec accessibility). */
export function useDocumentTitle(pageTitle: string): void {
  useEffect(() => {
    document.title = `${pageTitle} · Eve`
  }, [pageTitle])
}
