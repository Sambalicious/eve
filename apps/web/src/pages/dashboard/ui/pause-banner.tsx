import { CirclePause } from "lucide-react"
import { Link } from "react-router-dom"

import { homeCopy } from "@/entities/job-posting"
import { formatWatDate } from "@/shared/lib/format-wat"
import { Button } from "@/shared/ui/button"
import { useHomePause } from "../model/use-home-pause"

/**
 * The pause banner on Home (AC-1.6), whatever the Advanced switch says: one banner that names when checks
 * resume and that the pasted job is saved. The global pause has no end date, so it names none. The link goes to
 * Pause and cost; with Advanced off it turns Advanced on for viewing first, so the control is there when it opens.
 */
export function HomePauseBanner() {
  const { state, advanced, failed, goToPauseAndCost } = useHomePause()
  if (!state || (!state.globalPaused && !state.costPause)) return null
  const text = state.globalPaused
    ? homeCopy.banner.pauseOpen
    : homeCopy.banner.pauseUntil(formatWatDate(state.costPause!.resumesAt))
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <p role="status" className="flex items-start gap-2 text-pretty [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-warning-text">
        <CirclePause aria-hidden="true" />
        <span>{text}</span>
      </p>
      {advanced ? (
        <Link to="/pause-and-cost" className="shrink-0 underline underline-offset-4">
          {homeCopy.banner.link}
        </Link>
      ) : (
        <Button variant="link" className="h-auto shrink-0 p-0" onClick={() => void goToPauseAndCost()}>
          {homeCopy.banner.link}
        </Button>
      )}
      {failed && <span role="alert" className="text-destructive-text">Couldn't turn on Advanced. Try again.</span>}
    </div>
  )
}
