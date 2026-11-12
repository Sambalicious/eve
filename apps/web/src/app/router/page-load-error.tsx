import { CircleAlert } from "lucide-react"

import { Alert, AlertAction, AlertTitle } from "@/shared/ui/alert"
import { Button } from "@/shared/ui/button"

/** C-ERR-1, design-spec.r1.md copy catalogue. */
const PAGE_LOAD_FAILED = "Couldn't load this page."

export function PageLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-md items-center p-6">
      <Alert variant="destructive">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>{PAGE_LOAD_FAILED}</AlertTitle>
        <AlertAction>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </AlertAction>
      </Alert>
    </main>
  )
}
