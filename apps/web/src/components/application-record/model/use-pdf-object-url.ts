import { useQuery } from "@tanstack/react-query"
import { useEffect, useMemo } from "react"

import { documentBlobQueryOptions } from "@/entities/application"

/**
 * Fetches the PDF with the session cookie and exposes it as a `blob:` URL for
 * the inline preview (contract: "fetch the PDF and show it from a blob: URL").
 * The Blob is retyped as application/pdf, so the browser can only treat it as
 * a PDF whatever the response said. Each URL is revoked when the bytes change
 * or the viewer unmounts.
 */
export function usePdfObjectUrl(pdfUrl: string, enabled: boolean): { url: string | null; isError: boolean; retry: () => void } {
  const blob = useQuery({ ...documentBlobQueryOptions(pdfUrl), enabled })
  const url = useMemo(() => (blob.data ? URL.createObjectURL(new Blob([blob.data], { type: "application/pdf" })) : null), [blob.data])
  useEffect(() => (url ? () => URL.revokeObjectURL(url) : undefined), [url])
  return { url, isError: blob.isError, retry: () => void blob.refetch() }
}
