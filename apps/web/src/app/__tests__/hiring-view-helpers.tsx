import { fireEvent, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DEFAULT_TARGET_ROLE_FAMILIES, type RoleFamilyValue } from "@eve/contracts"

import {
  controls,
  createCareerSetupApi,
  createControlsApi,
  createDiscoveryApi,
  createHiringSearchInputsApi,
  createStackPostsApi,
  server,
  signedInSession,
  type DiscoveryState,
  type HiringSearchInputsApiState,
  type StackPostsApiState,
} from "@/shared/testing"
import { renderApp } from "./test-app"

/**
 * Signs in, installs the Job criteria, controls, Stack posts, hiring search
 * inputs and Job Postings fakes (the last owns `POST /v1/job-postings/links`),
 * then opens `path` (default: the Hiring view). `criteria` overrides the saved
 * Job criteria; `hints` the Job Preferences behind the hint terms.
 */
export function openHiring(
  options: {
    path?: string
    discovery?: Partial<DiscoveryState>
    criteria?: Partial<{
      frameworks: string[]
      technologies: string[]
      targetRoleFamilies: RoleFamilyValue[]
    }>
    hints?: Partial<HiringSearchInputsApiState>
    controls?: Parameters<typeof controls>[0]
    /** Stack posts and (Phase 3) Hiring feeds, record and posts. */
    stack?: Partial<StackPostsApiState>
  } = {}
) {
  const career = createCareerSetupApi({
    jobCriteria: {
      minCoreMatchPercent: 70,
      frameworks: [],
      technologies: [],
      targetRoleFamilies: [...DEFAULT_TARGET_ROLE_FAMILIES],
      seniorityFloor: "hide_entry_level",
      version: 1,
      ...options.criteria,
    },
  })
  const hints = createHiringSearchInputsApi(options.hints)
  const discovery = createDiscoveryApi(options.discovery)
  const controlsApi = createControlsApi({
    controls: controls({ globalPaused: false, ...options.controls }),
  })
  // OWN-1: the feeds responses read the controls fake's global pause flag, so a pause or resume from the
  // header shows in the next feeds responses. A test that sets `stack.globalPaused` pins the feeds flag.
  const stack = createStackPostsApi(
    { globalPaused: controlsApi.state.controls.globalPaused, ...options.stack },
    options.stack?.globalPaused === undefined ? { globalPaused: () => controlsApi.state.controls.globalPaused } : {}
  )
  server.use(
    signedInSession,
    ...career.handlers,
    ...controlsApi.handlers,
    ...stack.handlers,
    ...hints.handlers,
    ...discovery.handlers
  )
  const user = userEvent.setup({ delay: null })
  return {
    ...renderApp(options.path ?? "/find-jobs?view=hiring"),
    career,
    discovery,
    hints,
    stack,
    user,
  }
}

/** The section, or its open dialog: results render inside the dialog, so result assertions use the same helper. */
export const checkRegion = async () =>
  screen.queryByRole("dialog", { name: "Check this job" }) ??
  (await screen.findByRole("region", { name: "Check this job" }))

/** The section's dialog, opened if it is closed. The form lives in it (EPIC-0011 owner decision). */
export const openCheck = async (): Promise<HTMLElement> => {
  const region = await checkRegion()
  const open = screen.queryByRole("dialog", { name: "Check this job" })
  if (open) return open
  fireEvent.click(within(region).getByRole("button", { name: "Check this job" }))
  return await screen.findByRole("dialog", { name: "Check this job" })
}

export const applicationLink = async () =>
  within(await openCheck()).getByRole("textbox", { name: "Application link" })

export const checkLink = () =>
  within(screen.getByRole("dialog", { name: "Check this job" })).getByRole("button", { name: "Check link" })

/** Paste requests the Job Postings fake recorded. */
export const pastes = (discovery: ReturnType<typeof createDiscoveryApi>) =>
  discovery.requests.filter((r) => r.path === "/v1/job-postings/links")


/** `openHiring` with Set up alerts open: for tests of the Hiring alert feeds, which now sit inside that section. */
export const openHiringFeeds = (options: Parameters<typeof openHiring>[0] = {}) =>
  openHiring({ path: "/find-jobs?view=hiring#set-up-alerts", ...options })
