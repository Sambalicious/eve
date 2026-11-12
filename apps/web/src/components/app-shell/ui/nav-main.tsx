import type { LucideIcon } from "lucide-react"
import { Link, useLocation } from "react-router-dom"

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/shared/ui/sidebar"

export interface NavItem {
  title: string
  url: string
  icon: LucideIcon
  /** Short status shown next to the item, such as "Draft". Included in the link's name. */
  badge?: string | null
}

export function NavMain({ label, items }: { label: string | null; items: NavItem[] }) {
  const location = useLocation()

  return (
    <SidebarGroup>
      {label && <SidebarGroupLabel>{label}</SidebarGroupLabel>}
      <SidebarMenu>
        {items.map((item) => (
          <SidebarMenuItem key={item.title}>
            <SidebarMenuButton
              tooltip={item.badge ? `${item.title}, ${item.badge}` : item.title}
              className="cursor-pointer"
              isActive={location.pathname === item.url}
              render={<Link to={item.url} aria-current={location.pathname === item.url ? "page" : undefined} />}
            >
              <item.icon aria-hidden="true" />
              <span>{item.title}</span>
              {item.badge && <span className="sr-only">, {item.badge}</span>}
            </SidebarMenuButton>
            {item.badge && <SidebarMenuBadge aria-hidden="true">{item.badge}</SidebarMenuBadge>}
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
