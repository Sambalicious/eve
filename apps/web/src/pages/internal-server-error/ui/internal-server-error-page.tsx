import { ButtonLink } from "@/shared/ui/button-link"

export function InternalServerErrorPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-sidebar p-8 md:p-16">
      <div className="max-w-md text-center">
        <h1 className="mb-3 font-display text-6xl font-semibold tracking-[-0.03em] text-muted-foreground tabular-nums">
          500
        </h1>
        <h2 className="mb-2 font-display text-2xl font-semibold tracking-[-0.02em]">
          Internal Server Error
        </h2>
        <p className="text-muted-foreground">
          Something went wrong on our end. We&apos;re working to fix the issue.
          Please try again later.
        </p>
        <div className="mt-6 flex items-center justify-center gap-4 md:mt-8">
          <ButtonLink to="/dashboard">Go Back Home</ButtonLink>
        </div>
      </div>
    </div>
  )
}
