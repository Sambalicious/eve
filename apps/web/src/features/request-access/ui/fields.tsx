import * as React from "react"
import { cn } from "cn"
import { createLucideIcon } from "lucide-react"

/*
 * F-QA-E3B-01. "Try again" refetches only the form chunk under `?retry=N`; a
 * browser keeps any failed static import in its module map. So the form chunk
 * may import only modules the landing route has already loaded, or modules
 * that land in the form chunk itself. `@/shared/ui/input`, `textarea`,
 * lucide's `clock` and react-query's `useMutation` sit in chunks shared with
 * dashboard routes, which made separate dependency chunks. These local
 * equivalents keep the same classes and markup; check:budget fails if the form
 * chunk grows a separate dependency chunk again.
 */

const fieldClass =
  "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive dark:aria-invalid:ring-destructive/40"

/** Same look as `@/shared/ui/input`, without Base UI's field control. */
export function FormInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      className={cn("h-8 py-1 pointer-coarse:h-11 disabled:pointer-events-none", fieldClass, className)}
      {...props}
    />
  )
}

/** Same look as `@/shared/ui/textarea`. */
export function FormTextarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn("flex field-sizing-content min-h-16 py-2", fieldClass, className)} {...props} />
}

const LoaderCircle = createLucideIcon("loader-circle", [["path", { d: "M21 12a9 9 0 1 1-6.219-8.56", key: "13zald" }]])

/**
 * Same as `@/shared/ui/button-spinner`. lucide's `loader-circle` left the
 * entry chunk with the Base UI toast (design-spec r3), so it is built here
 * like `ClockIcon`, keeping the form free of dependency chunks.
 */
export function FormSpinner({ className, ...props }: React.ComponentProps<typeof LoaderCircle>) {
  return <LoaderCircle aria-hidden="true" className={cn("size-4 animate-spin motion-reduce:animate-none", className)} {...props} />
}

const Clock = createLucideIcon("clock", [
  ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ["path", { d: "M12 6v6l4 2", key: "mmk7yg" }],
])

/** lucide `clock`, built here so the form doesn't share a chunk with the postings page. */
export function ClockIcon(props: React.ComponentProps<typeof Clock>) {
  return <Clock {...props} />
}
