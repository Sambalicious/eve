import * as React from "react"
import { cn } from "cn"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

/**
 * Placeholder for text. Pass the same typography classes as the real text
 * (`text-sm`, `text-[0.8125rem] leading-relaxed`…): each line box then has
 * the real line height, so the skeleton is as tall as the text it stands for.
 * `widths` sets one bar per line, the last usually shorter.
 */
function SkeletonText({
  className,
  widths = ["w-40"],
}: {
  className?: string
  widths?: readonly string[]
}) {
  return (
    <span data-slot="skeleton-text" className={cn("flex w-full min-w-0 flex-col", className)}>
      {widths.map((width, i) => (
        <span key={i} className="block">
          <span className={cn("inline-block h-[0.8em] max-w-full animate-pulse rounded-sm bg-muted align-[-0.08em]", width)} />
        </span>
      ))}
    </span>
  )
}

/**
 * The frame of `Section` (section.tsx) with placeholder heading and
 * description, so a section skeleton lines up with the loaded section.
 */
function SkeletonSection({
  titleWidth = "w-32",
  descriptionWidths,
  actions,
  layout = "stack",
  className,
  children,
}: {
  titleWidth?: string
  descriptionWidths?: readonly string[]
  actions?: React.ReactNode
  layout?: "stack" | "split"
  className?: string
  children?: React.ReactNode
}) {
  return (
    <div
      data-slot="section"
      data-layout={layout}
      className={cn(
        "border-t border-border pt-7 first:border-t-0 first:pt-0",
        layout === "split" && "lg:grid lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] lg:gap-x-12",
        className
      )}
    >
      <div
        className={cn(
          "mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2",
          layout === "split" && "lg:mb-0 lg:flex-col lg:justify-start"
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <SkeletonText className="text-[0.9375rem] leading-snug font-semibold" widths={[titleWidth]} />
          {descriptionWidths && (
            <SkeletonText className="max-w-[60ch] text-[0.8125rem] leading-relaxed" widths={descriptionWidths} />
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** Button placeholders with the button sizes' heights, touch heights included. */
const skeletonButtonSize = {
  default: "h-8 pointer-coarse:h-10 rounded-lg",
  sm: "h-7 pointer-coarse:h-10 rounded-[min(var(--radius-md),12px)]",
  lg: "h-9 pointer-coarse:h-11 rounded-lg",
  icon: "size-8 pointer-coarse:size-10 rounded-lg",
} as const

function SkeletonButton({
  size = "default",
  className,
}: {
  size?: keyof typeof skeletonButtonSize
  className?: string
}) {
  return <Skeleton className={cn("shrink-0", skeletonButtonSize[size], size !== "icon" && "w-24", className)} />
}

/** Input placeholder: the Input's height and radius. */
function SkeletonInput({ className }: { className?: string }) {
  return <Skeleton className={cn("h-8 w-full rounded-lg pointer-coarse:h-11", className)} />
}

/** Badge placeholder (20px tall). */
function SkeletonBadge({ className }: { className?: string }) {
  return <Skeleton className={cn("h-5 w-20 shrink-0", className)} />
}

export { Skeleton, SkeletonBadge, SkeletonButton, SkeletonInput, SkeletonSection, SkeletonText }
