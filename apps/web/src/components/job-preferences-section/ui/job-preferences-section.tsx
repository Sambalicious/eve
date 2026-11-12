import type { ReactNode } from "react"

import { Section } from "@/shared/ui/section"

/**
 * Settings, "Job preferences" (`#preferences`, design-spec.r4 F4, r6 F23): the
 * heading is the `#preferences` focus target; the form's own sections sit inside.
 */
export function JobPreferencesSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Section id="preferences" title={title} headingProps={{ tabIndex: -1 }}>
      {children}
    </Section>
  )
}
