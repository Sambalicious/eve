import { ExternalLink } from "lucide-react"
import { cn } from "cn"

import { buttonVariants } from "@/shared/ui/button"

/** An outside link styled as an outline button, opening in a new tab (design-spec: links that navigate are links). */
export function ExternalButton({ href, label, download = false }: { href: string; label: string; download?: boolean }) {
  return download ? (
    <a href={href} download className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
      {label}
    </a>
  ) : (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
      {label}
      <ExternalLink aria-hidden="true" className="size-3.5" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  )
}
