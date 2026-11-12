import type { ReactNode } from "react"
import { CirclePause, CircleDollarSign } from "lucide-react"
import { useLocation } from "react-router-dom"

import { isAdvancedOn, useViewer } from "@/entities/viewer"
import { automationCopy, type AutomationState } from "@/entities/automation-state"
import { RaiseCeiling } from "@/features/raise-cost-ceiling"
import { ResumeAutomationButton } from "@/features/toggle-global-pause"
import { formatWatDate } from "@/shared/lib/format-wat"
import { Button } from "@/shared/ui/button"
import { ButtonLink } from "@/shared/ui/button-link"
import { useAutomationBanner } from "../model/use-automation-banner"

const c = automationCopy

/**
 * Automation banner (Composite blocks): full width under the header, warning
 * tint, not dismissible, `role="status"`. The global pause (C-PAUSE-2) comes
 * first; the cost pause (C-COST-1) has its own banner and stays when the
 * global pause is resumed. Below 640px each action is a full-width button.
 */
export function AutomationBanner() {
  const state = useAutomationBanner()
  const advanced = isAdvancedOn(useViewer())
  // Home carries its own pause banner (AC-1.6), so the shell's does not repeat it there.
  const onHome = useLocation().pathname === "/dashboard"
  if (onHome || !state || (!state.globalPaused && !state.costPause)) return null
  return (
    <div className="flex flex-col">
      {state.globalPaused && (
        <BannerRow icon={<CirclePause aria-hidden="true" />} text={c.pause.banner}>
          {advanced && <ResumeAutomationButton className="max-sm:w-full" />}
        </BannerRow>
      )}
      {state.costPause && <CostBanner state={state} resumesAt={state.costPause.resumesAt} />}
    </div>
  )
}

function CostBanner({ state, resumesAt }: { state: AutomationState; resumesAt: string }) {
  return (
    <BannerRow icon={<CircleDollarSign aria-hidden="true" />} text={c.cost.banner(state.spend.ceiling, formatWatDate(resumesAt))}>
      <RaiseCeiling
        spend={state.spend}
        costPause={state.costPause}
        trigger={(open) => (
          <Button variant="outline" size="sm" className="max-sm:w-full" onClick={open}>
            {c.cost.raise}
          </Button>
        )}
      />
      <ButtonLink to="/pause-and-cost#cost" variant="ghost" size="sm" className="max-sm:w-full">
        {c.cost.seeSpend}
      </ButtonLink>
    </BannerRow>
  )
}

function BannerRow({ icon, text, children }: { icon: ReactNode; text: string; children: ReactNode }) {
  return (
    <div className="border-b border-warning/30 bg-warning/10 px-4 py-3 lg:px-6">
      <div className="mx-auto flex max-w-[1280px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p role="status" className="flex min-w-0 items-start gap-2 text-sm text-pretty [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-warning-text">
          {icon}
          <span>{text}</span>
        </p>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">{children}</div>
      </div>
    </div>
  )
}
