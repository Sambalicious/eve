import { Hand } from "lucide-react"
import * as React from "react"
import { Link } from "react-router-dom"

import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/shared/ui/sidebar"
import { navCopy } from "../model/nav-copy"
import type { NeedsYouEntry } from "../model/nav-groups"

/**
 * The Needs you strip (AC-3.7): shows whatever the Advanced switch says. One kind waiting links
 * straight to its real page. More than one kind opens a small list with a row per kind.
 */
export function NeedsYouStrip({ entry }: { entry: NeedsYouEntry }) {
  const [open, setOpen] = React.useState(false)
  const listId = React.useId()
  const content = (
    <>
      <Hand aria-hidden="true" />
      <span>{navCopy.needsYouEntry}</span>
      <span className="sr-only">, {entry.total} {entry.total === 1 ? "item" : "items"} waiting</span>
    </>
  )
  return (
    <SidebarGroup>
      <SidebarMenu>
        <SidebarMenuItem>
          {entry.directUrl ? (
            <SidebarMenuButton
              className="cursor-pointer text-destructive"
              render={<Link to={entry.directUrl} />}
            >
              {content}
            </SidebarMenuButton>
          ) : (
            <SidebarMenuButton
              className="cursor-pointer text-destructive"
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => setOpen((value) => !value)}
            >
              {content}
            </SidebarMenuButton>
          )}
          <SidebarMenuBadge aria-hidden="true">{entry.total}</SidebarMenuBadge>
        </SidebarMenuItem>
        {!entry.directUrl && open && (
          <li id={listId} className="mx-3.5 flex flex-col gap-1 border-l border-sidebar-border px-2.5 py-1">
            <ul className="flex flex-col gap-1">
              {entry.rows.map((row) => (
                <li key={row.kind} className="flex flex-col text-[0.8125rem]">
                  <span className="text-sidebar-foreground">{row.label}</span>
                  <Link to={row.url} className="text-sidebar-foreground/80 underline underline-offset-4">
                    {row.linkLabel}
                  </Link>
                </li>
              ))}
            </ul>
          </li>
        )}
      </SidebarMenu>
    </SidebarGroup>
  )
}
