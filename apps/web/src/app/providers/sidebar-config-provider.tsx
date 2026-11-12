
import * as React from "react"

import { SidebarContext, type SidebarConfig } from "@/shared/lib/sidebar-config"

export function SidebarConfigProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [config, setConfig] = React.useState<SidebarConfig>({
    variant: "inset",
    collapsible: "offcanvas",
    side: "left",
  })

  const updateConfig = React.useCallback(
    (newConfig: Partial<SidebarConfig>) => {
      setConfig((prev) => ({ ...prev, ...newConfig }))
    },
    []
  )

  const value = React.useMemo(
    () => ({ config, updateConfig }),
    [config, updateConfig]
  )

  return (
    <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
  )
}
