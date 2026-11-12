import { CircleCheck, History, PencilLine, type LucideIcon } from "lucide-react"

import { Badge } from "@/shared/ui/badge"
import type { ProfileVersionStatus } from "../model/career-profile"

const STATUS_BADGES: Record<
  ProfileVersionStatus,
  { label: string; variant: "warning" | "success" | "outline"; icon: LucideIcon }
> = {
  draft: { label: "Draft", variant: "warning", icon: PencilLine },
  approved: { label: "Approved", variant: "success", icon: CircleCheck },
  replaced: { label: "Replaced", variant: "outline", icon: History },
}

/** Draft / Approved / Replaced, icon plus text (design-spec status vocabulary). */
export function VersionStatusBadge({ status }: { status: ProfileVersionStatus }) {
  const { label, variant, icon: Icon } = STATUS_BADGES[status]
  return (
    <Badge variant={variant}>
      <Icon aria-hidden="true" />
      {label}
    </Badge>
  )
}
