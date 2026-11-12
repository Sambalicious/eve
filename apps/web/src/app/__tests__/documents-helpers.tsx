import userEvent from "@testing-library/user-event"
import { vi } from "vitest"

import {
  createCareerSetupApi,
  createDiscoveryApi,
  createDocumentsApi,
  linkFakes,
  server,
  signedInSession,
  type DiscoveryState,
  type DocumentsState,
} from "@/shared/testing"
import { renderApp } from "./test-app"

/** Signs in, installs the slice 2, 3 and 4 fakes, and opens `path`. */
export function openDocuments(
  path: string,
  initial: Partial<DocumentsState> = {},
  options: { discovery?: Partial<DiscoveryState>; fakeTimers?: boolean } = {}
) {
  if (options.fakeTimers) {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
  }
  const discovery = createDiscoveryApi(options.discovery)
  const api = createDocumentsApi(initial)
  linkFakes(discovery, api)
  server.use(signedInSession, ...createCareerSetupApi().handlers, ...discovery.handlers, ...api.handlers)
  const user = userEvent.setup(options.fakeTimers ? { delay: null, advanceTimers: vi.advanceTimersByTime } : { delay: null })
  return { ...renderApp(path), api, discovery, user }
}
