import { SidebarTrigger } from "@/shared/ui/sidebar"
import { ModeToggle } from "@/features/toggle-theme"
import { isAdvancedOn, useViewer } from "@/entities/viewer"
import { PauseControl } from "@/features/toggle-global-pause"

export function SiteHeader() {
  const advanced = isAdvancedOn(useViewer())
  return (
    <header className="app-header sticky top-0 z-10 flex h-(--header-height) shrink-0 items-center gap-2 rounded-t-[inherit] border-b bg-background/80 backdrop-blur-md backdrop-saturate-150 group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 py-3 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1.5 text-muted-foreground hover:text-foreground" />
        <div className="ml-auto flex items-center gap-2">
          {advanced && <PauseControl />}
          <ModeToggle variant="ghost" />
        </div>
      </div>
    </header>
  )
}
