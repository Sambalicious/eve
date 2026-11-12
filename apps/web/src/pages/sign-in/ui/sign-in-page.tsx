import { DEFAULT_RETURN_PATH } from "@eve/contracts"
import { useQuery } from "@tanstack/react-query"
import { Link, Navigate, useSearchParams } from "react-router-dom"

import { SignInCardSkeleton } from "@/components/page-skeletons"
import { sessionQueryOptions } from "@/entities/session"
import { Wordmark } from "@/shared/ui/logo"
import { signInCopy } from "../model/copy"
import { parseSignInQuery } from "../model/sign-in-query"
import { GoogleSignIn } from "./google-sign-in"

/**
 * A signed-in Candidate goes to Home. Otherwise, including when the session
 * check fails for another reason, the page offers Google sign-in.
 */
export function SignInPage() {
  const [searchParams] = useSearchParams()
  const session = useQuery(sessionQueryOptions())

  if (session.isSuccess) return <Navigate to={DEFAULT_RETURN_PATH} replace />

  return (
    <div className="bg-sidebar flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <main className="flex w-full max-w-sm flex-col gap-6">
        {/* AC 10.6: public pages link back to the root through the wordmark. */}
        <Link to="/" aria-label="Eve, home" className="self-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <Wordmark className="text-foreground" />
        </Link>
        {session.isPending ? (
          <SignInCardSkeleton />
        ) : (
          <GoogleSignIn {...parseSignInQuery(searchParams)} />
        )}
        <p className="text-muted-foreground text-center text-xs">
          {signInCopy.note}
        </p>
      </main>
    </div>
  )
}
