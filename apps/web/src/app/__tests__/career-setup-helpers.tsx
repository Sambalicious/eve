import { act, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { vi } from "vitest"

import {
  createCareerSetupApi,
  server,
  signedInSession,
  type CareerSetupState,
} from "@/shared/testing"
import { renderApp } from "./test-app"

interface OpenOptions {
  /**
   * Fake the timers, for tests whose subject is a delay: the 5 s drafting
   * poll, or React Query's 1 s + 2 s retry backoff. The test then moves time
   * with `advance` instead of waiting for it. Time still flows normally too
   * (`shouldAdvanceTime`), so MSW, React and Testing Library behave as usual.
   * Restored by `restoreFakeTimers` in afterEach.
   */
  fakeTimers?: boolean
}

/**
 * Signs in, installs the stateful slice 2 API with `initial` state, and opens
 * `path`. Typing has no per-keystroke delay (`delay: null`): user-event's
 * default yields to a macrotask after every key, which costs a full scheduling
 * round per character on a busy machine and adds nothing these tests check.
 */
export function openSignedIn(path: string, initial: Partial<CareerSetupState> = {}, options: OpenOptions = {}) {
  if (options.fakeTimers) {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
  }
  const api = createCareerSetupApi(initial)
  server.use(signedInSession, ...api.handlers)
  const user = userEvent.setup(
    options.fakeTimers ? { delay: null, advanceTimers: vi.advanceTimersByTime } : { delay: null }
  )
  const view = renderApp(path)
  return { ...view, api, user }
}

/** Moves faked time forward by `ms` and lets React commit what it triggers. */
export async function advance(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms))
}

/** The open alert dialog (Base UI renders it in a portal). */
export async function findDialog(name: string) {
  return screen.findByRole("alertdialog", { name })
}

export async function confirmDialog(user: ReturnType<typeof userEvent.setup>, name: string, button: string) {
  const dialog = await findDialog(name)
  await user.click(within(dialog).getByRole("button", { name: button }))
}

/** The toast showing `text` (design-spec r3: Sonner, one item per toast). */
export async function findToast(text: string) {
  const [match] = await screen.findAllByText(text)
  return match.closest("[data-sonner-toast]")
}
