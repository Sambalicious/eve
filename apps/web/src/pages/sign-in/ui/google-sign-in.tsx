import { useEffect, useState } from "react"
import { SIGN_IN_START_PATH } from "@eve/contracts"

import { Button } from "@/shared/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card"
import { signInCopy } from "../model/copy"
import type { SignInQuery } from "../model/sign-in-query"
import { GoogleMark } from "./google-mark"
import { SignInNotice } from "./sign-in-notice"

/**
 * The sign-in card. Submitting the form is a full-page GET to the backend's
 * sign-in start URL with `next`, so the browser, not the app, talks to Google.
 */
export function GoogleSignIn({ next, notice }: SignInQuery) {
  const [isOpeningGoogle, setIsOpeningGoogle] = useOpeningGoogleState()

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle>
          <h1 className="font-display text-2xl font-semibold tracking-[-0.02em]">
            {signInCopy.title}
          </h1>
        </CardTitle>
        <CardDescription>{signInCopy.description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {notice && <SignInNotice notice={notice} />}
        <form
          method="get"
          action={SIGN_IN_START_PATH}
          onSubmit={() => setIsOpeningGoogle(true)}
        >
          <input type="hidden" name="next" value={next} />
          <Button
            type="submit"
            variant="outline"
            size="lg"
            className="w-full cursor-pointer gap-2"
            aria-busy={isOpeningGoogle}
            disabled={isOpeningGoogle}
            focusableWhenDisabled
          >
            {isOpeningGoogle ? <ButtonSpinner /> : <GoogleMark />}
            {isOpeningGoogle ? signInCopy.buttonLoading : signInCopy.button}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

/**
 * True from submit until the browser leaves. A page restored from the
 * back-forward cache starts over, so the button is usable again.
 */
function useOpeningGoogleState() {
  const state = useState(false)
  const setIsOpeningGoogle = state[1]
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setIsOpeningGoogle(false)
    }
    window.addEventListener("pageshow", reset)
    return () => window.removeEventListener("pageshow", reset)
  }, [setIsOpeningGoogle])
  return state
}

function ButtonSpinner() {
  return (
    <span
      aria-hidden="true"
      className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"
    />
  )
}
