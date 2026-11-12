import { Navigate, useLocation } from "react-router-dom"

import { useViewer } from "@/entities/viewer"
import { stackPostsTarget } from "./legacy-targets"

export function StackPostsRedirect() {
  const { search, hash } = useLocation()
  return <Navigate to={stackPostsTarget(search, hash)} replace />
}

/** `/sources` becomes Find jobs at the job boards for the Operator, and at Set up alerts for everyone else (AC-5.6). */
export function SourcesRedirect() {
  const { search, hash } = useLocation()
  const { isOperator } = useViewer()
  const anchor = hash !== "" ? hash : isOperator ? "#job-sources" : "#set-up-alerts"
  return <Navigate to={`/find-jobs${search}${anchor}`} replace />
}
