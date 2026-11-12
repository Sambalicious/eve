import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createBrowserRouter, RouterProvider } from "react-router-dom"
import "@fontsource-variable/geist"
import "@fontsource-variable/bricolage-grotesque/opsz.css"
import "../styles/index.css"

import { Step3 } from "./step3-preview"

/** Designer preview only: mounts wizard step 3's body (see step3-preview.tsx). */
export function mountStep3() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createBrowserRouter([{ path: "*", element: <Step3 /> }])
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>
  )
}

