import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Toaster, toast } from "./toast"

// app-toasts.feature (design-spec.r3 Interaction patterns > Toasts).

function region() {
  return screen.getByRole("region", { name: "Messages" })
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** Sonner mounts toasts on a timeout and removes them after an exit transition. */
async function raise(fn: () => void) {
  act(fn)
  await flush(20)
}

const visibleToasts = () => [...document.querySelectorAll("[data-sonner-toast]")].filter((el) => el.getAttribute("data-removed") !== "true")

afterEach(() => {
  vi.useRealTimers()
})

describe("app toasts", () => {
  it("names one polite region by app.toast.region_label and never takes focus", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(
      <>
        <input aria-label="Field" />
        <Toaster />
      </>
    )
    const field = screen.getByRole("textbox", { name: "Field" })
    field.focus()
    expect(screen.getAllByRole("region")).toHaveLength(1)
    expect(region()).toHaveAttribute("aria-live", "polite")

    await raise(() => toast.error("Couldn't approve Anthropic. Nothing changed. Try again."))

    expect(within(region()).getByText("Couldn't approve Anthropic. Nothing changed. Try again.")).toBeVisible()
    expect(screen.getAllByText("Couldn't approve Anthropic. Nothing changed. Try again.")).toHaveLength(1)
    expect(document.querySelectorAll("[role='alert']")).toHaveLength(0)
    expect(field).toHaveFocus()
  })

  it("every toast has a close control named by app.toast.close_label, and it removes the toast", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<Toaster />)
    await raise(() => toast.error("Couldn't approve Anthropic. Nothing changed. Try again."))

    expect(screen.queryByRole("button", { name: "Close toast" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Close message" }))
    await flush(600)
    expect(visibleToasts()).toHaveLength(0)
  })

  it.each([
    ["success", 3500, 4500],
    ["info", 3500, 4500],
    ["warning", 5500, 6500],
    ["error", 7500, 8500],
  ] as const)("a %s toast without an action is visible at %i ms and gone at %i ms", async (tone, before, after) => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    render(<Toaster />)
    await raise(() => toast[tone]("Message"))
    await flush(before - 20)
    expect(visibleToasts()).toHaveLength(1)
    await flush(after - before + 500)
    expect(visibleToasts()).toHaveLength(0)
  })

  it("an error toast with an action stays until closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    render(<Toaster />)
    await raise(() => toast.error("Failed", { action: { label: "Try again", onClick: () => undefined } }))
    await flush(60_000)
    expect(visibleToasts()).toHaveLength(1)
  })

  it("focus inside a toast holds its timer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    render(<Toaster />)
    await raise(() => toast.error("Failed"))
    await flush(2000)
    act(() => screen.getByRole("button", { name: "Close message" }).focus())
    await flush(15_000)
    expect(visibleToasts()).toHaveLength(1)
  })

  it("Escape on a focused toast dismisses it and returns focus to where it was", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(
      <>
        <button type="button">Save</button>
        <Toaster />
      </>
    )
    const save = screen.getByRole("button", { name: "Save" })
    save.focus()
    await raise(() => toast.error("Failed"))
    await user.keyboard("{Alt>}t{/Alt}")
    expect(region().contains(document.activeElement)).toBe(true)
    await user.keyboard("{Escape}")
    await flush(600)
    expect(visibleToasts()).toHaveLength(0)
    expect(save).toHaveFocus()
  })

  it("shows at most 3 toasts at once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    render(<Toaster />)
    await raise(() => {
      for (let i = 1; i <= 5; i += 1) toast.error(`Error ${i}`)
    })
    expect(document.querySelectorAll("[data-sonner-toast][data-visible='true']")).toHaveLength(3)
  })

  it("uses the tone on the edge and icon, never a filled status surface", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<Toaster />)
    await raise(() => toast.success("Recorded as a Manual Application."))
    const item = document.querySelector(".eve-toast")!
    expect(item).toHaveAttribute("data-tone", "success")
    expect(document.querySelector("[data-sonner-toast]")).not.toHaveAttribute("data-rich-colors", "true")
    expect(document.querySelector("[data-sonner-toast]")).toHaveAttribute("data-styled", "false")
  })

  it("follows the resolved theme", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { rerender } = render(<Toaster theme="light" />)
    await raise(() => toast.error("Failed", { action: { label: "Try again", onClick: () => undefined } }))
    expect(document.querySelector("[data-sonner-toaster]")).toHaveAttribute("data-sonner-theme", "light")
    rerender(<Toaster theme="dark" />)
    expect(document.querySelector("[data-sonner-toaster]")).toHaveAttribute("data-sonner-theme", "dark")
  })

  it("the same id replaces a toast instead of stacking a second one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<Toaster />)
    await raise(() => toast.error("First", { id: "one" }))
    await raise(() => toast.error("Second", { id: "one" }))
    expect(visibleToasts()).toHaveLength(1)
    expect(screen.getByText("Second")).toBeVisible()
  })

  it("an app toast raised while a modal is open waits, then shows after it closes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    const { rerender } = render(
      <>
        <div role="dialog" data-open="" aria-modal="true" />
        <Toaster />
      </>
    )
    await raise(() => toast.success("Saved."))
    await flush(10_000)
    expect(screen.getByText("Saved.")).toBeInTheDocument()
    rerender(<Toaster />)
    await flush(50)
    expect(visibleToasts()).toHaveLength(1)
    await flush(4600)
    expect(visibleToasts()).toHaveLength(0)
  })

  it("routes a dialog toast only to its own toaster", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(
      <>
        <Toaster />
        <Toaster id="request-access" label="Problems sending" hotkey={[]} />
      </>
    )
    await raise(() => toast.error("Couldn't send", { toasterId: "request-access" }))
    expect(within(screen.getByRole("region", { name: "Problems sending" })).getByText("Couldn't send")).toBeVisible()
    expect(within(region()).queryByText("Couldn't send")).not.toBeInTheDocument()
  })
})
