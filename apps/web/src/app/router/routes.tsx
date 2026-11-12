import type { ComponentType } from "react"
import { SIGN_IN_PAGE_PATH } from "@eve/contracts"
import type { RouteObject } from "react-router-dom"

import { RequireSession } from "./require-session"
import { SourcesRedirect, StackPostsRedirect } from "./legacy-redirects"

/** Code-split page modules, one per route. */
const pages = {
  landing: async () => (await import("@/pages/landing")).LandingPage,
  signIn: async () => (await import("@/pages/sign-in")).SignInPage,
  dashboard: async () => (await import("@/pages/dashboard")).DashboardPage,
  welcome: async () => (await import("@/pages/welcome")).WelcomePage,
  profile: async () => (await import("@/pages/profile")).ProfilePage,
  answers: async () => (await import("@/pages/answers")).AnswersPage,
  postings: async () => (await import("@/pages/postings")).PostingsPage,
  postingDetail: async () => (await import("@/pages/posting-detail")).PostingDetailPage,
  existingApplications: async () => (await import("@/pages/existing-applications")).ExistingApplicationsPage,
  applications: async () => (await import("@/pages/applications")).ApplicationsPage,
  pipeline: async () => (await import("@/pages/pipeline")).PipelinePage,
  applicationDetail: async () => (await import("@/pages/application-detail")).ApplicationDetailPage,
  documents: async () => (await import("@/pages/documents")).DocumentsPage,
  findJobs: async () => (await import("@/pages/find-jobs")).FindJobsPage,
  activation: async () => (await import("@/pages/activation")).ActivationPage,
  sampleReview: async () => (await import("@/pages/sample-review")).SampleReviewPage,
  blocked: async () => (await import("@/pages/blocked")).BlockedPage,
  uncertain: async () => (await import("@/pages/uncertain")).UncertainPage,
  pauseAndCost: async () => (await import("@/pages/pause-and-cost")).PauseAndCostPage,
  settings: async () => (await import("@/pages/settings")).SettingsPage,
  privacy: async () => (await import("@/pages/privacy")).PrivacyPage,
  internalServerError: async () =>
    (await import("@/pages/internal-server-error")).InternalServerErrorPage,
  notFound: async () => (await import("@/pages/not-found")).NotFoundPage,
} satisfies Record<string, () => Promise<ComponentType>>

/**
 * With the data router, a route's code loads before the navigation commits,
 * and the root layout shows a progress bar meanwhile.
 */
function page(load: () => Promise<ComponentType>) {
  return async () => ({ Component: await load() })
}

/** Loads every page module now, so later navigations do not wait for code. */
export async function preloadPages(): Promise<void> {
  await Promise.all(Object.values(pages).map((load) => load()))
}

/**
 * The landing page (`/`, `/about`) and the sign-in page are public; every
 * other route needs a session (design-spec.r1.md, global prerequisites;
 * EPIC-0003 architecture r1 section 1). The landing page sends a signed-in
 * Candidate from `/` to the dashboard itself.
 */
export const routes: RouteObject[] = [
  { path: "/", lazy: page(pages.landing) },
  { path: "/about", lazy: page(pages.landing) },
  { path: SIGN_IN_PAGE_PATH, lazy: page(pages.signIn) },
  {
    element: <RequireSession />,
    children: [
      { path: "/dashboard", lazy: page(pages.dashboard) },
      { path: "/welcome", lazy: page(pages.welcome) },
      { path: "/profile", lazy: page(pages.profile) },
      { path: "/answers", lazy: page(pages.answers) },
      { path: "/postings", lazy: page(pages.postings) },
      { path: "/postings/:postingId", lazy: page(pages.postingDetail) },
      { path: "/find-jobs", lazy: page(pages.findJobs) },
      { path: "/sources", element: <SourcesRedirect /> },
      { path: "/existing-applications", lazy: page(pages.existingApplications) },
      { path: "/applications", lazy: page(pages.applications) },
      { path: "/pipeline", lazy: page(pages.pipeline) },
      { path: "/applications/:applicationId", lazy: page(pages.applicationDetail) },
      { path: "/documents", lazy: page(pages.documents) },
      { path: "/stack-posts", element: <StackPostsRedirect /> },
      { path: "/activation", lazy: page(pages.activation) },
      { path: "/activation/:applicationId", lazy: page(pages.sampleReview) },
      { path: "/blocked", lazy: page(pages.blocked) },
      { path: "/uncertain", lazy: page(pages.uncertain) },
      { path: "/pause-and-cost", lazy: page(pages.pauseAndCost) },
      { path: "/settings", lazy: page(pages.settings) },
      { path: "/privacy", lazy: page(pages.privacy) },
      { path: "/errors/internal-server-error", lazy: page(pages.internalServerError) },
      { path: "*", lazy: page(pages.notFound) },
    ],
  },
]
