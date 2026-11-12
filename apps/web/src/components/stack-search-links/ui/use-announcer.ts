import { useEffect, useRef, useState } from "react"

export const COPIED_MS = 2000

/** A polite announcement that clears itself after 2 s (copy and family-change live text). */
export function useAnnouncer() {
  const [announcement, setAnnouncement] = useState("")
  const clearTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(clearTimer.current), [])
  const announce = (text: string) => {
    clearTimeout(clearTimer.current)
    setAnnouncement(text)
    clearTimer.current = setTimeout(() => setAnnouncement(""), COPIED_MS)
  }
  return { announcement, announce }
}
