import userEvent from "@testing-library/user-event"
import { vi } from "vitest"

import {
  createCareerSetupApi,
  createDiscoveryApi,
  createDocumentsApi,
  createSubmissionApi,
  linkFakes,
  readyApplication,
  server,
  signedInSession,
  type SubmissionApiState,
} from "@/shared/testing"
import type { ApplicationDetail, Submission } from "@eve/contracts"
import { renderApp } from "./test-app"

/** One Application and its Submission for a test's store. */
export function entry(submission: Submission, app: Partial<ApplicationDetail> = {}) {
  return { app: readyApplication(app), submission }
}

/** Signs in, installs the slice 2 to 5 fakes with these Applications, and opens `path`. `fakeTimers` fakes timers first (setup.ts restores them). */
export function openSubmission(
  path: string,
  entries: ReturnType<typeof entry>[] = [],
  initial: Partial<Omit<SubmissionApiState, "submissions">> = {},
  discovery: Parameters<typeof createDiscoveryApi>[0] = {},
  options: { fakeTimers?: boolean } = {}
) {
  if (options.fakeTimers) vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
  const documents = createDocumentsApi({ applications: entries.map((e) => e.app) })
  const submissions = Object.fromEntries(entries.map((e) => [e.app.id, e.submission]))
  const api = createSubmissionApi(documents, { ...initial, submissions })
  const career = createCareerSetupApi()
  const postings = createDiscoveryApi(discovery)
  linkFakes(postings, documents)
  server.use(signedInSession, ...career.handlers, ...postings.handlers, ...documents.handlers, ...api.handlers)
  const user = userEvent.setup(options.fakeTimers ? { delay: null, advanceTimers: vi.advanceTimersByTime } : { delay: null })
  return { ...renderApp(path), api, documents, career, discovery: postings, user }
}
