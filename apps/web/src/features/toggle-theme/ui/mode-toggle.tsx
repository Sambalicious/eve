import { Moon, Sun } from "lucide-react"
import { flushSync } from "react-dom"

import { Button } from "@/shared/ui/button"
import { useTheme } from "@/shared/lib/use-theme"
import { useResolvedDark } from "../model/use-resolved-dark"

interface ModeToggleProps {
  variant?: "outline" | "ghost" | "default"
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => unknown
}

/**
 * Switches to the opposite of what is on screen. The change cross-fades through
 * a view transition where supported (styles/index.css), and is instant otherwise
 * or under reduced motion.
 */
export function ModeToggle({ variant = "outline" }: ModeToggleProps) {
  const { setTheme } = useTheme()
  const isDark = useResolvedDark()

  const toggle = () => {
    const update = () => flushSync(() => setTheme(isDark ? "light" : "dark"))
    const doc = document as ViewTransitionDocument
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches
    if (doc.startViewTransition && !reduced) doc.startViewTransition(update)
    else update()
  }

  return (
    <Button
      variant={variant}
      size="icon"
      onClick={toggle}
      className="text-muted-foreground hover:text-foreground"
    >
      {isDark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
      <span className="sr-only">
        Switch to {isDark ? "light" : "dark"} mode
      </span>
    </Button>
  )
}
