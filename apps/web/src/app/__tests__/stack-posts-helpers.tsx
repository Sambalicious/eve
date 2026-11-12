import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect } from "vitest"
import type { JobCriteriaResponse } from "@eve/contracts"

import {
  controls,
  createCareerSetupApi,
  defaultJobCriteria,
  createControlsApi,
  createStackPostsApi,
  server,
  signedInSession,
  type ControlsApiState,
  type StackPostsApiState,
} from "@/shared/testing"
import { renderApp } from "./test-app"

/**
 * Signs in and installs the Job criteria, controls and Stack posts fakes, then
 * opens `path` (default `/find-jobs#set-up-alerts`: Set up alerts open, as the old Stack posts page showed its feeds). Criteria default to empty lists.
 */
export function openStackPosts(
  options: {
    path?: string
    criteria?: Pick<Partial<JobCriteriaResponse>, "frameworks" | "technologies">
    stack?: Partial<StackPostsApiState>
    globalPaused?: boolean
    controls?: Partial<ControlsApiState>
  } = {}
) {
  const career = createCareerSetupApi({
    jobCriteria: { ...defaultJobCriteria(), version: 1, ...options.criteria },
  })
  const controlsApi = createControlsApi({ controls: controls({ globalPaused: options.globalPaused ?? false }), ...options.controls })
  // OWN-1: the feeds responses read the controls fake's global pause flag, so a pause or resume from the
  // header shows in the next feeds responses. A test that sets `stack.globalPaused` pins the feeds flag.
  const stack = createStackPostsApi(
    { globalPaused: controlsApi.state.controls.globalPaused, ...options.stack },
    options.stack?.globalPaused === undefined ? { globalPaused: () => controlsApi.state.controls.globalPaused } : {}
  )
  server.use(signedInSession, ...career.handlers, ...controlsApi.handlers, ...stack.handlers)
  const user = userEvent.setup({ delay: null })
  return { ...renderApp(options.path ?? "/find-jobs#set-up-alerts"), career, stack, user }
}

/** "Posts" is the Stack posts section, titled "Posts from your field" on Find jobs. */
const TAB_FOR_REGION = {
  "Search links": "Search",
  Posts: "Posts from your field",
  "Alert feeds": "Set up alerts",
} as const

/** Selects the Find jobs tab that holds a region, so a test can read a panel other than the one it opened on. */
export async function showTab(name: "Search links" | "Alert feeds" | "Posts") {
  const tab =
    screen.queryByRole("tab", { name: TAB_FOR_REGION[name] }) ??
    (await screen.findByRole("tab", { name: TAB_FOR_REGION[name] }))
  if (tab.getAttribute("aria-selected") !== "true") fireEvent.click(tab)
}

export const region = async (name: "Search links" | "Alert feeds" | "Posts") => {
  await showTab(name)
  return screen.findByRole("region", { name: name === "Posts" ? "Posts from your field" : name })
}

export async function feedsRegion() {
  return region("Alert feeds")
}

/** The Alert feeds region once its data has loaded (the not-recorded panel or the recorded line is shown). */
export async function loadedFeeds() {
  const feeds = await feedsRegion()
  await waitFor(() =>
    expect(
      within(feeds).queryByText(/Confirm above to add feeds\./) ?? within(feeds).queryByText(/^Confirmed on/)
    ).not.toBeNull()
  )
  return feeds
}

/** The Posts region once its rows or its empty state are shown. */
export async function loadedPosts() {
  const posts = await region("Posts")
  await waitFor(() => expect(posts.querySelector("ol:not([aria-hidden]), h3")).not.toBeNull())
  return posts
}

/** The titles of the listed posts, in order. */
export function postTitles(posts: HTMLElement) {
  return within(posts).getAllByRole("listitem").map((li) => li.getAttribute("aria-label"))
}

/**
 * Pauses or resumes automation from the header control (resume confirms C-CONFIRM-10), then waits for
 * the header control to show the new state.
 */
export async function toggleHeaderPause(user: ReturnType<typeof userEvent.setup>, action: "pause" | "resume") {
  const header = screen.getByRole("banner")
  if (action === "pause") {
    await user.click(await within(header).findByRole("button", { name: "Pause automation" }))
  } else {
    await waitFor(() => expect(header.querySelector('button[aria-label="Resume automation"]')).not.toBeNull())
    await user.click(header.querySelector('button[aria-label="Resume automation"]') as HTMLElement)
    await user.click(within(await screen.findByRole("alertdialog", { name: "Resume automation?" })).getByRole("button", { name: "Resume automation" }))
  }
  const next = action === "pause" ? "Resume automation" : "Pause automation"
  await waitFor(() => expect(header.querySelector(`button[aria-label="${next}"]`)).not.toBeNull())
}
