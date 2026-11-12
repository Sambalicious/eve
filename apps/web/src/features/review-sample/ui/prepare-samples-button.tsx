import { submissionCopy } from "@/entities/application"
import { Button } from "@/shared/ui/button"
import { usePrepareSamples } from "../model/use-prepare-samples"

const p = submissionCopy.gate.prepare

/** "Prepare samples" on the Awaiting review tab. OPEN[designer]: the action and its copy aren't in the spec yet. */
export function PrepareSamplesButton({ variant = "default" }: { variant?: "default" | "outline" }) {
  const prepare = usePrepareSamples()
  return (
    <Button size="sm" variant={variant} aria-busy={prepare.isPending} disabled={prepare.isPending} onClick={prepare.run}>
      {prepare.isPending ? p.pending : p.action}
    </Button>
  )
}
