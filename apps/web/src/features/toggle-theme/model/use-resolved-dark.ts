import * as React from "react"

import { useTheme } from "@/shared/lib/use-theme"

const DARK_QUERY = "(prefers-color-scheme: dark)"

function subscribe(onChange: () => void) {
  const query = window.matchMedia(DARK_QUERY)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

const systemIsDark = () => window.matchMedia(DARK_QUERY).matches

/** True when the page is dark right now, whether chosen or inherited from the system. */
export function useResolvedDark(): boolean {
  const { theme } = useTheme()
  const system = React.useSyncExternalStore(
    subscribe,
    systemIsDark,
    () => false
  )
  return theme === "dark" || (theme === "system" && system)
}
