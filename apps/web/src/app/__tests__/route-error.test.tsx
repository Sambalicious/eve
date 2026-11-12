import { StrictMode } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { claimChunkReload, isChunkLoadError } from "../router/chunk-reload"
import { RouteError } from "../router/route-error"

const chunkError = () =>
  new TypeError(
    "Failed to fetch dynamically imported module: http://localhost/assets/dashboard-old.js"
  )

function renderFailingRoute(
  error: Error,
  onReload: () => void,
  strict = false
) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        errorElement: <RouteError onReload={onReload} />,
        children: [
          {
            path: "dashboard",
            lazy: async () => {
              throw error
            },
          },
        ],
      },
    ],
    { initialEntries: ["/dashboard"] }
  )
  const app = <RouterProvider router={router} />
  return render(strict ? <StrictMode>{app}</StrictMode> : app)
}

describe("route error boundary", () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it("reloads once when a page chunk fails, without showing an error", async () => {
    const onReload = vi.fn()
    renderFailingRoute(chunkError(), onReload)

    await vi.waitFor(() => expect(onReload).toHaveBeenCalledTimes(1))
    expect(screen.queryByText("Couldn't load this page.")).toBeNull()
    expect(screen.queryByText(/Unexpected Application Error/)).toBeNull()
  })

  it("still reloads under StrictMode's double render", async () => {
    const onReload = vi.fn()
    renderFailingRoute(chunkError(), onReload, true)

    await vi.waitFor(() => expect(onReload).toHaveBeenCalled())
    expect(screen.queryByText("Couldn't load this page.")).toBeNull()
  })

  it("shows C-ERR-1 when the chunk still fails right after a reload", async () => {
    sessionStorage.setItem("eve:chunk-reload-at", String(Date.now()))
    const onReload = vi.fn()
    renderFailingRoute(chunkError(), onReload)

    expect(
      await screen.findByText("Couldn't load this page.")
    ).toBeInTheDocument()
    expect(onReload).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it("shows C-ERR-1 for any other route error instead of the developer screen", async () => {
    const onReload = vi.fn()
    renderFailingRoute(new Error("boom"), onReload)

    expect(
      await screen.findByText("Couldn't load this page.")
    ).toBeInTheDocument()
    expect(screen.queryByText(/Unexpected Application Error/)).toBeNull()
    expect(onReload).not.toHaveBeenCalled()
  })
})

describe("chunk error helpers", () => {
  it.each([
    "Failed to fetch dynamically imported module: x.js",
    "Importing a module script failed.",
    "error loading dynamically imported module: x.js",
  ])("recognises %s", (message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true)
  })

  it("ignores other errors", () => {
    expect(isChunkLoadError(new Error("boom"))).toBe(false)
    expect(
      isChunkLoadError("Failed to fetch dynamically imported module")
    ).toBe(false)
  })

  it("allows one reload per 10 seconds", () => {
    sessionStorage.clear()
    expect(claimChunkReload(sessionStorage, 1_000)).toBe(true)
    expect(claimChunkReload(sessionStorage, 5_000)).toBe(false)
    expect(claimChunkReload(sessionStorage, 11_001)).toBe(true)
  })
})
