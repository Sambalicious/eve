import { ChevronRight, Hand } from "lucide-react"
import { Link } from "react-router-dom"

import { homeCopy } from "@/entities/job-posting"
import { Section } from "@/shared/ui/section"
import { useHomeNeedsYou } from "../model/use-home-needs-you"

/** Home's Needs you section with Advanced off (AC-3.7): one row per waiting kind, each linking to its real page. */
export function HomeNeedsYou() {
  const entry = useHomeNeedsYou()
  if (!entry) return null
  return (
    <Section title={homeCopy.needsYou.heading}>
      <ul className="flex flex-col divide-y">
        {entry.rows.map((row) => (
          <li key={row.kind}>
            <Link to={row.url} className="flex items-center justify-between gap-3 py-2.5 text-sm hover:underline">
              <span className="flex items-center gap-2">
                <Hand aria-hidden="true" className="size-4 shrink-0 text-destructive-text" />
                {row.label}
              </span>
              <span className="flex items-center gap-1 text-muted-foreground">
                {row.linkLabel}
                <ChevronRight aria-hidden="true" className="size-4" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  )
}
