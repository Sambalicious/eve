import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"

import { createAccessRequestApi, server } from "@/shared/testing"
import { RequestAccess } from "./request-access"

// F-QA-E3-02, request-access.feature:249, through the real loader. The static
// import keeps rejecting, as a browser's module map does after a failed fetch;
// only a fresh URL loads the form.
const chunk = vi.hoisted(() => ({ staticCalls: 0, urls: [] as string[] }))
vi.mock("../model/request-access-loader", async () => {
  const real = await vi.importActual<typeof import("../model/request-access-loader")>("../model/request-access-loader")
  const url = `${window.location.origin}/assets/request-access-abc123.js`
  return {
    loadRequestAccessForm: real.createChunkLoader(
      () => {
        chunk.staticCalls += 1
        return Promise.reject(new TypeError(`Failed to fetch dynamically imported module: ${url}`))
      },
      (retryUrl) => {
        chunk.urls.push(retryUrl)
        return import("@/features/request-access")
      }
    ),
  }
})

describe("RequestAccess chunk retry (real loader)", () => {
  it("the first import fails; Try again imports a fresh URL and renders the form", async () => {
    server.use(...createAccessRequestApi().handlers)
    const user = userEvent.setup({ delay: null })
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RequestAccess />
      </QueryClientProvider>
    )
    // A bare click with no focus event, so the open is the only first import.
    fireEvent.click(screen.getByRole("button", { name: "Request access" }))
    const dialog = screen.getByRole("dialog", { name: "Request access" })
    await within(dialog).findByRole("button", { name: "Try again" })

    // r3: Try again is the load-error toast's action, inside the dialog's own toaster.
    await user.click(within(within(dialog).getByRole("region", { name: "Problems sending" })).getByRole("button", { name: "Try again" }))

    expect(await within(dialog).findByRole("textbox", { name: "Email" })).toHaveFocus()
    expect(chunk.staticCalls).toBe(1)
    expect(chunk.urls).toEqual([`${window.location.origin}/assets/request-access-abc123.js?retry=1`])
  })
})
