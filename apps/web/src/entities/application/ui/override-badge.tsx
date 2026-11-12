import { Signature } from "lucide-react"

import { Badge } from "@/shared/ui/badge"
import { overrideCopy } from "../model/copy"

/** C-AA-15: the quiet outline "Override" tag after the status badge (design B3, B5). Shown whenever an override is recorded. */
export function OverrideBadge() {
  return (
    <Badge variant="outline">
      <Signature aria-hidden="true" />
      {overrideCopy.badge}
    </Badge>
  )
}
