import { ClipboardPaste } from "lucide-react"

import { Badge } from "@/shared/ui/badge"
import { pastedApplicationCopy } from "../model/pasted-copy"

/** C-PD-51: the outline "Pasted, manual only" mark in the Override badge slot (design B3, B4). Never shown with Override. */
export function PastedApplicationBadge() {
  return (
    <Badge variant="outline">
      <ClipboardPaste aria-hidden="true" />
      {pastedApplicationCopy.badge}
    </Badge>
  )
}
