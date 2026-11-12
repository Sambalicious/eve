import { Pause, Play } from "lucide-react"

import { automationCopy } from "@/entities/automation-state"
import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { useGlobalPause } from "../model/use-global-pause"
import { ResumeDialog } from "./resume-dialog"

const p = automationCopy.pause

/**
 * Header pause control (Composite blocks): outline "Pause automation" while
 * running, primary "Resume automation" while paused. Icon-only below 640px
 * with the same accessible name; no `aria-pressed`, since the banner states it.
 */
export function PauseControl() {
  const { isPaused, isPending, pause, askResume, confirmingResume, setConfirmingResume, resume } = useGlobalPause()
  if (isPaused === null) return null
  const label = isPaused ? p.resume : p.pause
  return (
    <>
      <Button
        variant={isPaused ? "default" : "outline"}
        size="sm"
        aria-label={label}
        aria-busy={isPending && !confirmingResume}
        disabled={isPending}
        // Keeps focus on the control while the PUT is pending (aria-disabled,
        // clicks ignored): a natively disabled button loses focus to <body>
        // and doesn't get it back when it becomes "Resume automation" (QG-FU2-01).
        focusableWhenDisabled
        onClick={isPaused ? askResume : pause}
      >
        {isPending && !confirmingResume ? <ButtonSpinner /> : isPaused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
        <span className="max-sm:sr-only">{label}</span>
      </Button>
      <ResumeDialog open={confirmingResume} onOpenChange={setConfirmingResume} isPending={isPending} onConfirm={resume} />
    </>
  )
}

/** "Resume automation" inside the C-PAUSE-2 banner; same confirm as the header control. */
export function ResumeAutomationButton({ className }: { className?: string }) {
  const { isPending, askResume, confirmingResume, setConfirmingResume, resume } = useGlobalPause()
  return (
    <>
      <Button variant="outline" size="sm" className={className} onClick={askResume}>
        {p.resume}
      </Button>
      <ResumeDialog open={confirmingResume} onOpenChange={setConfirmingResume} isPending={isPending} onConfirm={resume} />
    </>
  )
}
