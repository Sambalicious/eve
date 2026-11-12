import { useEffect, useRef } from "react"
import { CircleCheck, CircleQuestionMark, Info, TriangleAlert } from "lucide-react"
import { Link } from "react-router-dom"

import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert"
import type { SampleOutcome } from "../model/sample-result-copy"

/** The result that replaces the action bar after an approval. Focus moves to it. */
export function SampleOutcomeAlert({ outcome }: { outcome: SampleOutcome }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const Icon = outcome.title ? TriangleAlert : outcome.tone === "success" ? CircleCheck : outcome.tone === "warning" ? CircleQuestionMark : Info
  return (
    <Alert ref={ref} tabIndex={-1} role="status" className={outcome.title ? "border-warning/40 outline-none *:[svg]:text-warning-text" : "outline-none"}>
      <Icon aria-hidden="true" />
      {outcome.title ? (
        <AlertTitle>{outcome.title}</AlertTitle>
      ) : (
        <AlertTitle className="font-normal text-pretty">{outcome.line}</AlertTitle>
      )}
      {(outcome.title || outcome.countLine || outcome.link) && (
        <AlertDescription className="flex flex-col items-start gap-1 [&_p:not(:last-child)]:mb-0">
          {outcome.title && <p className="text-pretty">{outcome.line}</p>}
          {outcome.countLine && <p>{outcome.countLine}</p>}
          {outcome.link && (
            <Link to={outcome.link.to} className="text-foreground underline underline-offset-4">
              {outcome.link.label}
            </Link>
          )}
        </AlertDescription>
      )}
    </Alert>
  )
}
