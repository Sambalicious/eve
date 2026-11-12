import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { createAccessRequestApi, server } from "@/shared/testing"
import { RequestAccess } from "./request-access"

// The seam is the chunk loader (a dynamic import), not the network: the form's
// API calls still go through MSW.
const loader = vi.hoisted(() => ({ fail: 0, calls: 0, gate: null as Promise<void> | null }))
vi.mock("../model/request-access-loader", async () => {
  const real = await vi.importActual<typeof import("../model/request-access-loader")>("../model/request-access-loader")
  return {
    loadRequestAccessForm: async () => {
      loader.calls += 1
      if (loader.gate) await loader.gate
      if (loader.fail > 0) {
        loader.fail -= 1
        throw new TypeError("Failed to fetch dynamically imported module")
      }
      return real.loadRequestAccessForm()
    },
  }
})

function renderButton() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <RequestAccess />
    </QueryClientProvider>
  )
}

const dialog = () => screen.getByRole("dialog", { name: "Request access" })

describe("RequestAccess shell (request-access.feature, lazy chunk)", () => {
  beforeEach(() => {
    loader.fail = 0
    loader.calls = 0
    loader.gate = null
    server.use(...createAccessRequestApi().handlers)
  })

  it("opens the frame at once with the real header and a busy, text-free skeleton while the chunk loads", async () => {
    let release!: () => void
    loader.gate = new Promise((resolve) => (release = resolve))
    const user = userEvent.setup({ delay: null })
    renderButton()
    await user.click(screen.getByRole("button", { name: "Request access" }))

    expect(within(dialog()).getByRole("heading", { name: "Request access" })).toBeInTheDocument()
    expect(within(dialog()).getByRole("button", { name: "Close" })).toBeInTheDocument()
    const skeleton = screen.getByTestId("request-skeleton")
    expect(skeleton).toHaveAttribute("aria-busy", "true")
    expect(skeleton).toHaveTextContent("")
    expect(dialog().querySelector(".animate-spin")).toBeNull()

    await act(async () => release())
    expect(await within(dialog()).findByRole("textbox", { name: "Email" })).toHaveFocus()
    expect(screen.queryByTestId("request-skeleton")).not.toBeInTheDocument()
  })

  it("keeps focus where the visitor moved it before the chunk loaded", async () => {
    let release!: () => void
    loader.gate = new Promise((resolve) => (release = resolve))
    const user = userEvent.setup({ delay: null })
    renderButton()
    await user.click(screen.getByRole("button", { name: "Request access" }))
    within(dialog()).getByRole("button", { name: "Close" }).focus()

    await act(async () => release())
    await within(dialog()).findByRole("textbox", { name: "Email" })
    expect(within(dialog()).getByRole("button", { name: "Close" })).toHaveFocus()
  })

  it("Escape closes while the chunk is still loading and focus returns to the button", async () => {
    loader.gate = new Promise(() => {})
    const user = userEvent.setup({ delay: null })
    renderButton()
    await user.click(screen.getByRole("button", { name: "Request access" }))
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Request access" })).toHaveFocus()
  })

  it("a chunk failure shows a load-error toast with Try again in the dialog's toaster; the skeleton stops; Try again loads the form", async () => {
    // The click focuses the button first: the focus prefetch and the open each import once here.
    loader.fail = 2
    const user = userEvent.setup({ delay: null })
    renderButton()
    await user.click(screen.getByRole("button", { name: "Request access" }))

    const region = within(dialog()).getByRole("region", { name: "Problems sending" })
    const toastItem = await within(region).findByText("The request form couldn't load.")
    expect(within(dialog()).queryByRole("textbox")).not.toBeInTheDocument()
    expect(dialog().querySelectorAll('[role="alert"], [data-slot="alert"]')).toHaveLength(0)
    // Error text lives once, in the toast; the status region carries success only.
    expect(within(dialog()).getByRole("status")).toBeEmptyDOMElement()
    const skeleton = screen.getByTestId("request-skeleton")
    expect(skeleton).toHaveAttribute("aria-busy", "false")
    expect(skeleton).toHaveAttribute("data-frozen")
    expect(within(region).getByRole("button", { name: "Close message" })).toBeInTheDocument()
    expect(toastItem).toBeVisible()

    await user.click(within(region).getByRole("button", { name: "Try again" }))
    expect(await within(dialog()).findByRole("textbox", { name: "Email" })).toBeInTheDocument()
    await waitFor(() => expect(within(region).queryByText("The request form couldn't load.")).not.toBeInTheDocument())
  })

  // DR-E3F-01, request-access.feature:279: focus on the toast's own Try again is not the visitor moving focus.
  it("Try again in the load-error toast puts focus on the email field, by click or by Enter", async () => {
    for (const press of ["click", "enter"] as const) {
      loader.fail = 2
      const user = userEvent.setup({ delay: null })
      const { unmount } = render(
        <QueryClientProvider client={new QueryClient()}>
          <RequestAccess />
        </QueryClientProvider>
      )
      await user.click(screen.getByRole("button", { name: "Request access" }))
      const region = within(dialog()).getByRole("region", { name: "Problems sending" })
      await within(region).findByText("The request form couldn't load.")
      const retry = within(region).getByRole("button", { name: "Try again" })
      if (press === "click") await user.click(retry)
      else {
        act(() => retry.focus())
        await user.keyboard("{Enter}")
      }

      const email = await within(dialog()).findByRole("textbox", { name: "Email" })
      expect(email).toHaveFocus()
      await waitFor(() => expect(within(region).queryByText("The request form couldn't load.")).not.toBeInTheDocument())
      expect(email).toHaveFocus()
      unmount()
    }
  })

  it("after Try again, focus the visitor moves to Close while the chunk loads is kept", async () => {
    loader.fail = 2
    const user = userEvent.setup({ delay: null })
    renderButton()
    await user.click(screen.getByRole("button", { name: "Request access" }))
    const region = within(dialog()).getByRole("region", { name: "Problems sending" })
    await within(region).findByText("The request form couldn't load.")
    let release!: () => void
    loader.gate = new Promise((resolve) => (release = resolve))
    await user.click(within(region).getByRole("button", { name: "Try again" }))
    within(dialog()).getByRole("button", { name: "Close" }).focus()

    await act(async () => release())
    await within(dialog()).findByRole("textbox", { name: "Email" })
    expect(within(dialog()).getByRole("button", { name: "Close" })).toHaveFocus()
  })

  it("closing the dialog after a chunk failure removes the load-error toast", async () => {
    loader.fail = 99
    const user = userEvent.setup({ delay: null })
    renderButton()
    await user.click(screen.getByRole("button", { name: "Request access" }))
    await within(dialog()).findByText("The request form couldn't load.")
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(0)
    expect(screen.getByRole("button", { name: "Request access" })).toHaveFocus()
  })

  it("focus on the button starts loading the chunk without opening the dialog", async () => {
    renderButton()
    act(() => screen.getByRole("button", { name: "Request access" }).focus())
    await waitFor(() => expect(loader.calls).toBe(1))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })
})
