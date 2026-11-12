import { CircleX, FileCheck, LoaderCircle, TriangleAlert } from "lucide-react"

import { Badge } from "@/shared/ui/badge"
import { applicationCopy } from "../model/copy"
import type { ApplicationState } from "../model/application"

/**
 * Status badge for a slice 4 Application (C-DOC-5 to C-DOC-8), with the
 * variants and icons from the status vocabulary.
 */
export function ApplicationStatusBadge({ state }: { state: ApplicationState }) {
  switch (state) {
    case "generating":
      return (
        <Badge variant="info">
          <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          {applicationCopy.badge.draft}
        </Badge>
      )
    case "documents_blocked":
      return (
        <Badge variant="destructive">
          <CircleX aria-hidden="true" />
          {applicationCopy.badge.draft}
        </Badge>
      )
    case "documents_failed":
      return (
        <Badge variant="warning">
          <TriangleAlert aria-hidden="true" />
          {applicationCopy.badge.draft}
        </Badge>
      )
    case "prepared":
    case "documents_ready":
      return (
        <Badge variant="info">
          <FileCheck aria-hidden="true" />
          {applicationCopy.badge.draft}
        </Badge>
      )
  }
}
