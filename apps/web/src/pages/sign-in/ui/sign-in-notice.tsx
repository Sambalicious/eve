import { useEffect, useRef } from "react"
import { CircleAlert, Info } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert"
import { signInCopy } from "../model/copy"
import type { SignInNotice as Notice } from "../model/sign-in-query"

/** The alert slot above the sign-in button: C-AUTH-1, C-AUTH-2 or C-AUTH-3. */
export function SignInNotice({ notice }: { notice: Notice }) {
  switch (notice.kind) {
    case "failed":
      return (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{signInCopy.failed}</AlertTitle>
        </Alert>
      )
    case "expired":
      return (
        <Alert role="status">
          <Info aria-hidden="true" />
          <AlertTitle className="text-pretty">{signInCopy.expired}</AlertTitle>
        </Alert>
      )
    case "refused":
      return <RefusedAccountNotice email={notice.email} />
    default: {
      const exhaustive: never = notice
      return exhaustive
    }
  }
}

/** C-AUTH-3. Focus moves to its heading on page load (design-spec.r1.md, accessibility). */
function RefusedAccountNotice({ email }: { email: string | null }) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => headingRef.current?.focus(), [])

  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>
        <h2 ref={headingRef} tabIndex={-1} className="outline-none">
          {signInCopy.refusedTitle}
        </h2>
      </AlertTitle>
      <AlertDescription className="[overflow-wrap:anywhere]">
        {email
          ? signInCopy.refusedWithEmail(email)
          : signInCopy.refusedWithoutEmail}
      </AlertDescription>
    </Alert>
  )
}
