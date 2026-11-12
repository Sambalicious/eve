import { CalendarCheck, MailCheck, MailWarning, MailX, PartyPopper } from "lucide-react"

import { Badge } from "@/shared/ui/badge"
import { outcomeCopy } from "../model/copy"
import type { OutcomeType } from "../model/outcome"

/** Outcome badge (status vocabulary): icon plus text, never colour alone. */
export function OutcomeTypeBadge({ type }: { type: OutcomeType }) {
  const label = outcomeCopy.type[type]
  switch (type) {
    case "confirmation":
      return <Badge variant="secondary"><MailCheck aria-hidden="true" />{label}</Badge>
    case "rejection":
      return <Badge variant="outline"><MailX aria-hidden="true" />{label}</Badge>
    case "interview_invitation":
      return <Badge variant="success"><CalendarCheck aria-hidden="true" />{label}</Badge>
    case "request_for_action":
      return <Badge variant="warning"><MailWarning aria-hidden="true" />{label}</Badge>
    case "offer":
      return <Badge variant="success"><PartyPopper aria-hidden="true" />{label}</Badge>
  }
}
