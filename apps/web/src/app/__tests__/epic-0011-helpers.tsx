import userEvent from "@testing-library/user-event"
import type { ApplicationDetail, MeResponse, Submission } from "@eve/contracts"

import {
  approvedState,
  createCareerSetupApi,
  createControlsApi,
  createDiscoveryApi,
  createDocumentsApi,
  createMeApi,
  createSubmissionApi,
  linkFakes,
  linkOutcomes,
  operatorMe,
  readyApplication,
  server,
  signedInSession,
  version,
  type CareerSetupState,
  type SubmissionApiState,
} from "@/shared/testing"
import { createHiringSearchInputsApi, createStackPostsApi } from "@/shared/testing"
import { renderApp } from "./test-app"

interface OpenOptions {
  me?: MeResponse
  entries?: { app: ApplicationDetail; submission: Submission }[]
  status?: SubmissionApiState["status"]
  career?: Partial<CareerSetupState>
  discovery?: Parameters<typeof createDiscoveryApi>[0]
  meDelayMs?: number
  meFails?: boolean
  controls?: ReturnType<typeof import("@/shared/testing").controls>
}

/** A profile in use and the AI provider approved: the state Home's paste box needs. */
export const profileInUse = (): Partial<CareerSetupState> => ({ ...approvedState(), versions: [version(1, "approved")] })

export const entryOf = (submission: Submission, app: Partial<ApplicationDetail> = {}) => ({ app: readyApplication(app), submission })

/**
 * Signs in as `me` (default: the Operator with Advanced on), installs every fake the app reads, and opens `path`.
 * The fakes are returned so a test can read what was written.
 */
export function openEve(path: string, options: OpenOptions = {}) {
  const meApi = createMeApi(options.me ?? operatorMe(), { delayMs: options.meDelayMs, failRead: options.meFails })
  const entries = options.entries ?? []
  const documents = createDocumentsApi({ applications: entries.map((e) => e.app) })
  const controls = createControlsApi(options.controls ? { controls: options.controls } : {})
  linkOutcomes(documents, controls)
  const submissions = Object.fromEntries(entries.map((e) => [e.app.id, e.submission]))
  const submission = createSubmissionApi(documents, { ...(options.status ? { status: options.status } : {}), submissions }, { viewer: meApi.state })
  const career = createCareerSetupApi(options.career ?? profileInUse())
  const discovery = createDiscoveryApi(options.discovery ?? {})
  linkFakes(discovery, documents)
  const stack = createStackPostsApi()
  server.use(
    signedInSession,
    ...meApi.handlers,
    ...career.handlers,
    ...discovery.handlers,
    ...documents.handlers,
    ...controls.handlers,
    ...submission.handlers,
    ...stack.handlers,
    ...createHiringSearchInputsApi().handlers
  )
  const user = userEvent.setup({ delay: null })
  return { ...renderApp(path), user, meApi, documents, controls, submission, career, discovery, stack }
}
