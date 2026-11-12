import * as React from "react"
import { AppSidebar, AppSidebarSkeleton } from "./app-sidebar"
import { AutomationBanner } from "./automation-banner"
import { SiteHeader } from "./site-header"
import { useViewer, isAdvancedOn } from "@/entities/viewer"
import { TurnOnAdvancedNote } from "@/features/toggle-advanced"
import { useSidebarConfig } from "@/shared/lib/use-sidebar-config"
import { SidebarInset, SidebarProvider } from "@/shared/ui/sidebar"
import { Skeleton } from "@/shared/ui/skeleton"

interface AppShellProps {
  children: React.ReactNode
  title?: string
  description?: string
  /** An Advanced-only page: with Advanced off the page still loads, with the note and "Turn on Advanced" above it (AC-3.6). */
  advancedOnly?: boolean
}

function ShellFrame({
  sidebar: Sidebar,
  banner,
  heading,
  children,
}: {
  sidebar: typeof AppSidebar
  /** Under the header: the automation banner in the real shell; none in the skeleton. */
  banner?: React.ReactNode
  heading: React.ReactNode
  children: React.ReactNode
}) {
  const { config } = useSidebarConfig()

  const sidebar = (
    <Sidebar
      variant={config.variant}
      collapsible={config.collapsible}
      side={config.side}
    />
  )

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "16rem",
          "--sidebar-width-icon": "3rem",
          "--header-height": "calc(var(--spacing) * 14)",
        } as React.CSSProperties
      }
      className={config.collapsible === "none" ? "sidebar-none-mode" : ""}
    >
      {config.side === "left" && sidebar}
      <SidebarInset>
        <SiteHeader />
        {banner}
        <div className="flex flex-1 flex-col">
          <div className="@container/main flex flex-1 flex-col gap-2">
            <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-5 pt-6 pb-12 md:gap-7 md:pt-10 md:pb-16">
              {heading}
              {children}
            </div>
          </div>
        </div>
      </SidebarInset>
      {config.side === "right" && sidebar}
    </SidebarProvider>
  )
}

function PageHeading({ title, description }: { title: React.ReactNode; description?: React.ReactNode }) {
  return (
    <div className="px-4 pb-1 lg:px-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-display text-[1.875rem] leading-[1.15] font-semibold tracking-[-0.02em] md:text-[2.25rem]">
          {title}
        </h1>
        {description && (
          <p className="max-w-[60ch] text-[0.9375rem] text-muted-foreground">
            {description}
          </p>
        )}
      </div>
    </div>
  )
}

export function AppShell({ children, title, description, advancedOnly }: AppShellProps) {
  const viewer = useViewer()
  return (
    <ShellFrame
      sidebar={AppSidebar}
      banner={<AutomationBanner />}
      heading={title && <PageHeading title={title} description={description} />}
    >
      {advancedOnly && !isAdvancedOn(viewer) && <TurnOnAdvancedNote />}
      {children}
    </ShellFrame>
  )
}

interface AppShellSkeletonProps {
  children: React.ReactNode
  /** The page's static title. Omit for a page whose title comes from its data. */
  title?: string
  description?: string
  /** For a data title: the width of its placeholder bar. */
  titleWidth?: string
}

/**
 * The app shell while the session is confirmed: the same frame with a
 * skeleton sidebar and no API requests. A static page title shows as text,
 * a data title as a bar of the same height.
 */
export function AppShellSkeleton({ children, title, description, titleWidth = "w-2/3 max-w-md" }: AppShellSkeletonProps) {
  return (
    <ShellFrame
      sidebar={AppSidebarSkeleton}
      heading={
        title ? (
          <PageHeading title={title} description={description} />
        ) : (
          <PageTitleSkeleton width={titleWidth} />
        )
      }
    >
      {children}
    </ShellFrame>
  )
}

/** A data-driven page title while it loads: one line of the h1's height (34.5px, 41.4px from md). */
export function PageTitleSkeleton({ width = "w-2/3 max-w-md" }: { width?: string }) {
  return (
    <div className="px-4 pb-1 lg:px-6" aria-hidden="true">
      <div className="flex h-[34.5px] items-center md:h-[41.4px]">
        <Skeleton className={`h-7 md:h-8 ${width}`} />
      </div>
    </div>
  )
}
