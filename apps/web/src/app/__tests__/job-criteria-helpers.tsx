import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { JobCriteriaResponse } from "@eve/contracts"

import {
  createCareerSetupApi,
  defaultJobCriteria,
  createDiscoveryApi,
  createDocumentsApi,
  linkFakes,
  server,
  signedInSession,
  type DiscoveryState,
  type DocumentsState,
} from "@/shared/testing"
import { renderApp } from "./test-app"

/**
 * Signs in and installs the stateful career-setup (Job criteria), discovery and
 * documents fakes, then opens `path`. `criteria` seeds the stored Job criteria
 * (version 1 unless given).
 */
export function openWithCriteria(
  path: string,
  options: {
    criteria?: Partial<JobCriteriaResponse>
    discovery?: Partial<DiscoveryState>
    documents?: Partial<DocumentsState>
  } = {}
) {
  const career = createCareerSetupApi({
    jobCriteria: { ...defaultJobCriteria(), version: 1, ...options.criteria },
  })
  const discovery = createDiscoveryApi(options.discovery)
  const documents = createDocumentsApi(options.documents)
  linkFakes(discovery, documents)
  server.use(signedInSession, ...career.handlers, ...discovery.handlers, ...documents.handlers)
  const user = userEvent.setup({ delay: null })
  return { ...renderApp(path), career, discovery, documents, user }
}

export async function criteriaSection() {
  return screen.findByRole("region", { name: "Job criteria" })
}
