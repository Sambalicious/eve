import userEvent from "@testing-library/user-event"
import { vi } from "vitest"

import {
  createCareerSetupApi,
  createDiscoveryApi,
  server,
  signedInSession,
  type DiscoveryState,
} from "@/shared/testing"
import { renderApp } from "./test-app"

/** Signs in, installs the stateful slice 3 API (over a fresh slice 2 API), and opens `path`. */
export function openDiscovery(path: string, initial: Partial<DiscoveryState> = {}, options: { fakeTimers?: boolean } = {}) {
  if (options.fakeTimers) {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
  }
  const api = createDiscoveryApi(initial)
  server.use(signedInSession, ...createCareerSetupApi().handlers, ...api.handlers)
  const user = userEvent.setup(options.fakeTimers ? { delay: null, advanceTimers: vi.advanceTimersByTime } : { delay: null })
  const view = renderApp(path)
  return { ...view, api, user }
}
