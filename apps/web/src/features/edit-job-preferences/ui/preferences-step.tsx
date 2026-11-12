import { useEffect, useRef } from "react"

import type { JobPreferences, SavedJobPreferences } from "@/entities/job-preferences"
import { prefsCopy as c } from "../model/copy"
import { JobPreferencesForm } from "./job-preferences-form"

/**
 * Wizard step 3 body (design-spec.r4 F3 table row 3, `C-WIZ-S3-T`): the step
 * `h1` (focused on arrival, F3 step 3), the lead, and the same Job Preferences
 * form in wizard mode: "Save and continue", no toast, no after-save lines, and
 * C-WIZ-ERR-1 / C-WIZ-ERR-2 for failures. The wizard shell, rail and routing
 * are slice C; it calls `onSaved` to advance.
 */
export function PreferencesStep({ preferences, onSaved }: { preferences: JobPreferences; onSaved: (saved: SavedJobPreferences) => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => headingRef.current?.focus(), [])
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 ref={headingRef} tabIndex={-1} className="font-display text-[1.875rem] leading-[1.15] font-semibold tracking-[-0.02em] outline-none md:text-4xl">
          {c.wizard.title}
        </h1>
        <p className="max-w-[60ch] text-sm text-muted-foreground">{c.wizard.lead}</p>
      </header>
      <JobPreferencesForm mode="wizard" preferences={preferences} onSaved={onSaved} />
    </div>
  )
}
