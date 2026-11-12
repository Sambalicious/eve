import * as React from "react"

interface LogoProps extends React.SVGProps<SVGSVGElement> {
  size?: number
}

/** The Eve mark: a single-stroke lowercase "e". Inherits `currentColor`. */
export function Logo({ size = 24, className, ...props }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
      {...props}
    >
      <path
        d="M3.75 12H20.25A8.25 8.25 0 1 0 17.83 17.83"
        stroke="currentColor"
        strokeWidth={2.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Mark plus the serif wordmark, used where the product introduces itself. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={["inline-flex items-center gap-2", className]
        .filter(Boolean)
        .join(" ")}
    >
      <Logo size={20} className="shrink-0 text-primary" />
      <span className="font-display text-[1.375rem] leading-none font-semibold tracking-[-0.02em]">
        Eve
      </span>
    </span>
  )
}
