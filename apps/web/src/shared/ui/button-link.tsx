import type { VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Link, type LinkProps } from "react-router-dom"

import { buttonVariants } from "@/shared/ui/button"

/**
 * A route link styled as a button (design-spec.r3 Accessibility, CR2-08). It
 * renders a plain `<a>` with the link role: no `Button` wrapper, so Base UI
 * neither warns about a non-native button nor adds `role="button"`, which
 * would hide that the control navigates.
 */
export function ButtonLink({ className, variant, size, ...props }: LinkProps & VariantProps<typeof buttonVariants>) {
  return <Link data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
