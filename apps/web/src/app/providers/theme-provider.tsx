import * as React from "react"
import { ThemeProviderContext } from "@/shared/lib/theme-context"

type Theme = "dark" | "light" | "system"

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
  storageKey?: string
  /** A key used before a rename; read once, moved to `storageKey`, then removed. */
  legacyStorageKey?: string
}

const THEMES: readonly Theme[] = ["dark", "light", "system"]
const isTheme = (value: string | null): value is Theme =>
  value !== null && (THEMES as readonly string[]).includes(value)

function readStoredTheme(
  storageKey: string,
  legacyKey: string | undefined
): Theme | null {
  const current = localStorage.getItem(storageKey)
  if (isTheme(current)) return current
  if (!legacyKey) return null
  const legacy = localStorage.getItem(legacyKey)
  if (!isTheme(legacy)) return null
  localStorage.setItem(storageKey, legacy)
  localStorage.removeItem(legacyKey)
  return legacy
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "vite-ui-theme",
  legacyStorageKey,
  ...props
}: ThemeProviderProps) {
  const [theme, setTheme] = React.useState<Theme>(
    () => readStoredTheme(storageKey, legacyStorageKey) ?? defaultTheme
  )

  React.useLayoutEffect(() => {
    const root = window.document.documentElement
    const query = window.matchMedia("(prefers-color-scheme: dark)")
    const apply = () => {
      const resolved =
        theme === "system" ? (query.matches ? "dark" : "light") : theme
      root.classList.remove("light", "dark")
      root.classList.add(resolved)
    }
    apply()
    if (theme !== "system") return
    // Follow the OS while the Candidate hasn't picked a theme.
    query.addEventListener("change", apply)
    return () => query.removeEventListener("change", apply)
  }, [theme])

  const value = {
    theme,
    setTheme: (theme: Theme) => {
      localStorage.setItem(storageKey, theme)
      setTheme(theme)
    },
  }

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}
