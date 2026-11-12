import * as React from "react"
import {
  SidebarContext,
  type SidebarContextValue,
} from "@/shared/lib/sidebar-config"

export function useSidebarConfig(): SidebarContextValue {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error(
      "useSidebarConfig must be used within a SidebarConfigProvider"
    )
  }
  return context
}
