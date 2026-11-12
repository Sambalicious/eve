import { ButtonLink } from "@/shared/ui/button-link"

export function NotFoundPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-sidebar p-8 md:p-16">
      <div className="max-w-md text-center">
        <h1 className="mb-3 font-display text-6xl font-semibold tracking-[-0.03em] text-muted-foreground tabular-nums">
          404
        </h1>
        <h2 className="mb-2 font-display text-2xl font-semibold tracking-[-0.02em]">
          Page Not Found
        </h2>
        <p className="text-muted-foreground">
          The page you are looking for doesn&apos;t exist or has been moved to
          another location.
        </p>
        <div className="mt-6 flex items-center justify-center gap-4 md:mt-8">
          <ButtonLink to="/dashboard">Go Back Home</ButtonLink>
        </div>
      </div>
    </div>
  )
}
