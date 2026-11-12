import { QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "react-router-dom"

import { SessionEndingContext } from "@/entities/session"
import { useResolvedDark } from "@/features/toggle-theme"
import { Toaster } from "@/shared/ui/toast"
import { createApp } from "./create-app"
import { ThemeProvider } from "./providers/theme-provider"
import { SidebarConfigProvider } from "./providers/sidebar-config-provider"

type AppInstance = ReturnType<typeof createApp>

/** The app toaster follows the resolved theme; Sonner defaults to light. */
function AppToaster() {
  return <Toaster theme={useResolvedDark() ? "dark" : "light"} />
}

export function App({ app }: { app: AppInstance }) {
  return (
    <div className="font-sans antialiased">
      <QueryClientProvider client={app.queryClient}>
        <SessionEndingContext.Provider value={app.sessionEnding}>
          <ThemeProvider
            defaultTheme="system"
            storageKey="eve-theme"
            legacyStorageKey="job-assistant-theme"
          >
            <SidebarConfigProvider>
              <RouterProvider router={app.router} />
              <AppToaster />
            </SidebarConfigProvider>
          </ThemeProvider>
        </SessionEndingContext.Provider>
      </QueryClientProvider>
    </div>
  )
}
