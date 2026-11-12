import * as React from "react"
import { Link } from "react-router-dom"
import { Wordmark } from "@/shared/ui/logo"

import { useCareerProfileBadge } from "../model/use-career-profile-badge"
import { SAFE_VIEWER, useViewer } from "@/entities/viewer"
import { navModel, type NavModel } from "../model/nav-groups"
import { useNeedsYouCounts } from "../model/use-needs-you-badges"
import { useSidebarUser } from "../model/use-sidebar-user"
import { NavMain } from "./nav-main"
import { NeedsYouStrip } from "./needs-you-strip"
import { NavUser, NavUserSkeleton } from "./nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/shared/ui/sidebar"

function SidebarFrame({
  nav,
  footer,
  ...props
}: React.ComponentProps<typeof Sidebar> & { nav: NavModel; footer: React.ReactNode }) {
  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              className="h-11 hover:bg-transparent active:bg-transparent"
              render={<Link to="/dashboard" aria-label="Eve" />}
            >
              <Wordmark className="px-0.5 text-sidebar-foreground" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {nav.needsYou && <NeedsYouStrip entry={nav.needsYou} />}
        {nav.groups.map((group) => (
          <NavMain key={group.label ?? "default"} label={group.label} items={group.items} />
        ))}
      </SidebarContent>
      <SidebarFooter>{footer}</SidebarFooter>
    </Sidebar>
  )
}

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const profile = useCareerProfileBadge()
  const counts = useNeedsYouCounts()
  const viewer = useViewer()
  const user = useSidebarUser()
  return (
    <SidebarFrame
      {...props}
      nav={navModel(viewer, counts, profile)}
      footer={user ? <NavUser user={user} /> : <NavUserSkeleton />}
    />
  )
}

/**
 * The same sidebar before the session is confirmed: the six default items without
 * counts and the account button as a skeleton. It makes no API requests and never
 * shows the Advanced group (AC-3.8).
 */
export function AppSidebarSkeleton(props: React.ComponentProps<typeof Sidebar>) {
  return <SidebarFrame {...props} nav={navModel(SAFE_VIEWER, {}, null)} footer={<NavUserSkeleton />} />
}
