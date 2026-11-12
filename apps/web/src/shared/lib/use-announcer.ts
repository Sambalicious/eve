import { useCallback, useEffect, useRef, useState } from "react"

/**
 * The text of the page's one `role="status"` region. Saying the same string
 * twice clears the region first, so screen readers announce it again.
 */
export function useAnnouncer() {
  const [message, setMessage] = useState("")
  const frame = useRef<number | null>(null)

  useEffect(() => () => cancel(frame), [])

  const announce = useCallback((text: string) => {
    cancel(frame)
    setMessage("")
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      setMessage(text)
    })
  }, [])

  return { message, announce }
}

function cancel(frame: { current: number | null }) {
  if (frame.current !== null) cancelAnimationFrame(frame.current)
  frame.current = null
}
