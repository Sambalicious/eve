import { useQuery } from "@tanstack/react-query"

import { preferencesQueryOptions } from "@/entities/job-preferences"
import { PreferencesStep } from "@/features/edit-job-preferences"

/**
 * Designer preview only (`/preview/step-3`): wizard step 3's body in a bare
 * 760px column. The wizard shell, rail and routing are slice C (design-spec.r4 F3).
 */
export function Step3() {
  const prefs = useQuery(preferencesQueryOptions())
  return (
    <main className="mx-auto w-full max-w-[760px] px-4 py-8 lg:px-6">
      {prefs.data ? <PreferencesStep preferences={prefs.data} onSaved={(saved) => console.info("[preview] step 3 saved version", saved.version)} /> : <p>Loading…</p>}
    </main>
  )
}
