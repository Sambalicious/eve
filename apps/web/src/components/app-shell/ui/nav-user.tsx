import * as React from "react"
import { EllipsisVertical, ShieldCheck } from "lucide-react"
import { Link } from "react-router-dom"

import { SignOutDialog, SignOutMenuItem } from "@/features/sign-out"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/shared/ui/sidebar"
import { Skeleton } from "@/shared/ui/skeleton"

export function NavUser({
  user,
}: {
  user: {
    name: string
    email: string
    avatar: string
  }
}) {
  const [confirmingSignOut, setConfirmingSignOut] = React.useState(false)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                ref={triggerRef}
                size="lg"
                className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground cursor-pointer"
              />
            }
          >
            <UserInitial name={user.name} />
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{user.name}</span>
              <span className="text-muted-foreground truncate text-xs">
                {user.email}
              </span>
            </div>
            <EllipsisVertical className="ml-auto" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--anchor-width) min-w-56 rounded-xl"
            side="top"
            align="start"
            sideOffset={6}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="p-0 font-normal text-foreground">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <UserInitial name={user.name} />
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{user.name}</span>
                    <span className="text-muted-foreground truncate text-xs">
                      {user.email}
                    </span>
                  </div>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {/* NAV:89: Data and privacy left the sidebar; the account menu keeps it. */}
              <DropdownMenuItem render={<Link to="/privacy" />}>
                <ShieldCheck aria-hidden="true" />
                Data and privacy
              </DropdownMenuItem>
              <SignOutMenuItem onSelect={() => setConfirmingSignOut(true)} />
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <SignOutDialog open={confirmingSignOut} onOpenChange={setConfirmingSignOut} finalFocus={triggerRef} />
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

/** Same box as the account button (size lg: 48px tall, 32px initial, name line). */
export function NavUserSkeleton() {
  return (
    <SidebarMenu aria-hidden="true">
      <SidebarMenuItem>
        <div data-slot="nav-user-skeleton" className="flex h-12 w-full items-center gap-2 p-2">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <Skeleton className="h-3.5 w-28" />
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function UserInitial({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-accent font-display text-sm font-semibold text-sidebar-accent-foreground"
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  )
}
