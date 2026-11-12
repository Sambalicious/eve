import type { ReactNode } from "react"

interface IllustrationProps {
  /** `illo-<name>`: a class hook for size and a prefix for any ids. */
  name: string
  /** viewBox width and height; the wrapper reserves this aspect ratio. */
  width: number
  height: number
  className?: string
  children: ReactNode
}

/**
 * One wrapper for every landing spot illustration (design-spec r3
 * Illustration system). Decorative: hidden from assistive tech, never
 * focusable, no title or role. The wrapper reserves the aspect ratio so the
 * drawing never shifts layout. Paints come from the --illo-* tokens.
 */
export function Illustration({ name, width, height, className, children }: IllustrationProps) {
  return (
    <div aria-hidden="true" className={`illo illo-${name}${className ? ` ${className}` : ""}`} style={{ aspectRatio: `${width} / ${height}` }}>
      <svg viewBox={`0 0 ${width} ${height}`} focusable="false" fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </div>
  )
}
