import * as React from "react"
import { cn } from "cn"

type HeadingLevel = "h2" | "h3"

interface SectionProps extends Omit<React.ComponentProps<"section">, "title"> {
  /** Visible heading. It also names the region for assistive tech. */
  title: React.ReactNode
  description?: React.ReactNode
  /** Controls aligned with the heading, such as one secondary action. */
  actions?: React.ReactNode
  /** `split` puts the heading beside the content from lg (settings pages). */
  layout?: "stack" | "split"
  headingLevel?: HeadingLevel
  /** Props for the heading element, for focus targets and ids. */
  headingProps?: React.ComponentProps<"h2">
}

/**
 * An open, labelled page section (DESIGN.md, "ledger rule"). Sections stack
 * with a hairline between siblings; there is no card around the content.
 */
function Section({
  title,
  description,
  actions,
  layout = "stack",
  headingLevel = "h2",
  headingProps,
  className,
  children,
  ...props
}: SectionProps) {
  const generatedId = React.useId()
  const headingId = headingProps?.id ?? `${generatedId}-heading`
  const Heading = headingLevel
  return (
    <section
      data-slot="section"
      data-layout={layout}
      aria-labelledby={headingId}
      className={cn(
        "group/section scroll-mt-20 border-t border-border pt-7 first:border-t-0 first:pt-0",
        layout === "split" &&
          "lg:grid lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] lg:gap-x-12",
        className
      )}
      {...props}
    >
      <div
        data-slot="section-header"
        className={cn(
          "mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2",
          layout === "split" && "lg:mb-0 lg:flex-col lg:justify-start"
        )}
      >
        <div className="flex min-w-0 flex-col gap-1">
          <Heading
            {...headingProps}
            id={headingId}
            className={cn(
              "text-[0.9375rem] leading-snug font-semibold tracking-[-0.01em] outline-none",
              headingProps?.className
            )}
          >
            {title}
          </Heading>
          {description && (
            <div className="max-w-[60ch] text-[0.8125rem] leading-relaxed text-muted-foreground">
              {description}
            </div>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        )}
      </div>
      <div data-slot="section-content" className="min-w-0">
        {children}
      </div>
    </section>
  )
}

/** A soft, borderless fill for empty, locked or informational content inside a section. */
function SectionNote({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="section-note"
      className={cn("rounded-xl bg-muted/60 px-4 py-3.5 text-sm", className)}
      {...props}
    />
  )
}

/** The page's vertical rhythm: sections separated by 28px and a hairline. */
function SectionStack({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="section-stack"
      className={cn("flex flex-col gap-7", className)}
      {...props}
    />
  )
}

export { Section, SectionNote, SectionStack }

interface QuietEmptyProps {
  icon: React.ReactNode
  title: React.ReactNode
  /** Heading level for the title; empty states that replace a page's content use h2. */
  titleAs?: "h1" | "h2" | "h3" | "p"
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}

/**
 * An empty or zero state that sits in the page flow (DESIGN.md rule 4): a soft
 * fill with a small icon, one line of title, one of description, and at most
 * one action. No dashed border, no centred hero.
 */
function QuietEmpty({
  icon,
  title,
  titleAs: Title = "h2",
  description,
  action,
  className,
}: QuietEmptyProps) {
  return (
    <SectionNote
      className={cn(
        "flex flex-col items-start gap-3 px-5 py-5 sm:flex-row sm:items-center sm:gap-4",
        className
      )}
    >
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground ring-1 ring-border [&_svg]:size-4"
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Title className="text-sm font-semibold">{title}</Title>
        {description && (
          <p className="text-[0.8125rem] text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </SectionNote>
  )
}

export { QuietEmpty }
