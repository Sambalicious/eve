import type { ReactNode } from "react"
import { matchPath } from "react-router-dom"

import { DashboardSkeleton } from "../ui/dashboard-skeleton"
import {
  AnswersSkeleton,
  ApplicationsListSkeleton,
  ExistingApplicationsSkeleton,
  JobSourcesSkeleton,
  PrivacySkeleton,
  ProfileSkeleton,
  SettingsSkeleton,
} from "../ui/setup-skeletons"
import {
  ApplicationDetailSkeleton,
  BlockedSkeleton,
  BreadcrumbSkeleton,
  DocumentsListSkeleton,
  GateStatusCardSkeleton,
  PostingDetailSkeleton,
  PostingsSkeleton,
  SampleReviewSkeleton,
  SampleTabsSkeleton,
  UncertainSkeleton,
} from "../ui/work-skeletons"
import { StackPostsSkeleton } from "../ui/stack-posts-skeletons"

export interface RouteSkeleton {
  /** The page's static AppShell title and description; none for a page titled by its data. */
  title?: string
  description?: string
  /** The page's content area as it will lay out once loaded. */
  content: ReactNode
}

const FIND_DESCRIPTION = "Search for jobs and read hiring posts. Set up alerts if you want new ones delivered."

const container = (width: string, children: ReactNode, gap = "gap-7") => (
  <div className={`flex w-full ${width} flex-col ${gap} px-4 lg:px-6`}>{children}</div>
)

/**
 * Titles are the pages' own copy (C-HOME-1/2, the slice copy objects). They
 * are repeated here as plain strings so the first-load skeleton stays free of
 * entity imports; a page test checks each title against the loaded page.
 */
const ROUTES: readonly [pattern: string, skeleton: () => RouteSkeleton][] = [
  ["/dashboard", () => ({ title: "Home", description: "Paste a job. Eve checks how well it fits your profile, then prepares a resume and cover letter.", content: <DashboardSkeleton /> })],
  ["/profile", () => ({ title: "Profile", description: "The facts Eve may use. Every resume and cover letter it writes comes from these and nothing else.", content: container("max-w-[960px]", <ProfileSkeleton />) })],
  ["/answers", () => ({ title: "Form answers", content: container("max-w-[760px]", <AnswersSkeleton />) })],
  ["/postings", () => ({ title: "Jobs", description: "Jobs Eve found and jobs you pasted, with how well each fits your profile.", content: <PostingsSkeleton /> })],
  [
    "/postings/:postingId",
    () => ({
      content: container(
        "max-w-[1120px]",
        <>
          <BreadcrumbSkeleton parentWidth="w-24" />
          <PostingDetailSkeleton />
        </>,
        "gap-4"
      ),
    }),
  ],
  ["/sources", () => ({ title: "Find jobs", description: FIND_DESCRIPTION, content: container("max-w-[1120px]", <JobSourcesSkeleton />) })],
  ["/find-jobs", () => ({ title: "Find jobs", description: FIND_DESCRIPTION, content: container("max-w-[1120px]", <StackPostsSkeleton />) })],
  ["/welcome", () => ({ title: "Upload your resume", description: "Eve reads your resume and builds a profile. It uses that profile to check jobs and write your documents.", content: container("max-w-[760px]", <ProfileSkeleton />) })],
  ["/pause-and-cost", () => ({ title: "Pause and cost", description: "Pause Eve's checks and see this month's AI cost against your ceiling.", content: container("max-w-[960px]", <SettingsSkeleton />) })],
  [
    "/existing-applications",
    () => ({
      title: "Existing applications",
      description: "Jobs you applied to before Eve, so it never applies to them twice.",
      content: container("max-w-[1120px]", <ExistingApplicationsSkeleton />),
    }),
  ],
  ["/applications", () => ({ title: "Applications", description: "Every application Eve has prepared, by stage. Move a card when something changes.", content: container("max-w-[1120px]", <ApplicationsListSkeleton />, "gap-4") })],
  [
    "/applications/:applicationId",
    () => ({
      content: container(
        "max-w-[1120px]",
        <>
          <BreadcrumbSkeleton parentWidth="w-20" />
          <ApplicationDetailSkeleton />
        </>,
        "gap-4"
      ),
    }),
  ],
  ["/documents", () => ({ title: "Documents", content: container("max-w-[1120px]", <DocumentsListSkeleton />, "gap-4") })],
  ["/stack-posts", () => ({ title: "Find jobs", description: FIND_DESCRIPTION, content: container("max-w-[1120px]", <StackPostsSkeleton />) })],
  [
    "/activation",
    () => ({
      title: "Check first sends",
      content: (
        <div className="flex flex-col gap-6 px-4 lg:px-6">
          <GateStatusCardSkeleton />
          <SampleTabsSkeleton />
        </div>
      ),
    }),
  ],
  [
    "/activation/:applicationId",
    () => ({
      content: container(
        "mx-auto max-w-[1280px]",
        <>
          <BreadcrumbSkeleton parentWidth="w-28" />
          <SampleReviewSkeleton />
        </>,
        "gap-4"
      ),
    }),
  ],
  ["/blocked", () => ({ title: "Blocked", content: <div className="flex flex-col gap-6 px-4 lg:px-6"><BlockedSkeleton /></div> })],
  ["/uncertain", () => ({ title: "Unsure sends", content: <div className="flex flex-col gap-3 px-4 lg:px-6"><UncertainSkeleton /></div> })],
  ["/settings", () => ({ title: "Settings", description: "Your job preferences, contact details and privacy.", content: container("max-w-[960px]", <SettingsSkeleton />) })],
  ["/privacy", () => ({ title: "Data and privacy", content: container("max-w-[960px]", <PrivacySkeleton />) })],
]

/** The skeleton for the dashboard page at `pathname`, or null for a path with no page skeleton. */
export function routeSkeleton(pathname: string): RouteSkeleton | null {
  for (const [pattern, skeleton] of ROUTES) {
    if (matchPath({ path: pattern, end: true }, pathname)) return skeleton()
  }
  return null
}
