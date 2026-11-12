import { useQuery } from "@tanstack/react-query"
import { useId } from "react"
import { Link, useParams } from "react-router-dom"

import { AppShell } from "@/components/app-shell"
import { DocumentsViewer } from "@/components/application-record"
import { EligibilityPanel, MatchPanel } from "@/components/posting-evidence"
import {
  applicationCopy,
  applicationName,
  applicationQueryOptions,
  ApplicationStatusBadge,
  isSampleSubmitting,
  submissionCopy,
  submissionQueryOptions,
  submissionStatusQueryOptions,
  SubmissionStatusBadge,
} from "@/entities/application"
import { EmployerPageLink, jobPostingCopy, jobPostingQueryOptions, UnverifiedLabels } from "@/entities/job-posting"
import { GenerateDocumentsButton } from "@/features/generate-documents"
import {
  criteriaNoteReason,
  FormAnswersPanel,
  MissingAnswerWarning,
  sampleOutcome,
  SampleActionBar,
  SampleCriteriaNote,
  SampleOutcomeAlert,
  useReviewSample,
} from "@/features/review-sample"
import { hasErrorCode } from "@/shared/api"
import { useDocumentTitle } from "@/shared/lib/use-document-title"
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/shared/ui/breadcrumb"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { SampleReviewSkeleton } from "@/components/page-skeletons"

const g = submissionCopy.gate
const sc = submissionCopy.sample

/**
 * Sample review (`/activation/:applicationId`, F2 step 3): everything that will
 * be sent. Header (role, company, requisition ID, Application System, status,
 * "Career Profile version {n}"), the action bar, the Job Posting, Eligibility,
 * Match, the Documents viewer and the form answers. After a result the action
 * bar is replaced by the result.
 */
export function SampleReviewPage() {
  const { applicationId = "" } = useParams()
  const notFoundRetry = (count: number, error: unknown) => !hasErrorCode(error, "not_found") && count < 3
  const app = useQuery({ ...applicationQueryOptions(applicationId), retry: notFoundRetry })
  // useReviewSample follows an unfinished sample with its own back-off, so this query doesn't poll as well.
  const submission = useQuery({ ...submissionQueryOptions(applicationId), retry: notFoundRetry, refetchInterval: false })
  const posting = useQuery({ ...jobPostingQueryOptions(app.data?.jobPostingId ?? ""), enabled: app.data !== undefined })
  const status = useQuery(submissionStatusQueryOptions())
  const review = useReviewSample(applicationId, submission.data)
  const name = app.data ? applicationName(app.data) : g.reviewSample
  useDocumentTitle(name)

  const company = app.data?.company ?? app.data?.requisitionId ?? ""
  const sample = submission.data?.sample
  const isAwaiting = sample?.state === "awaiting_review" && (!review.result || review.result.result === "not_submitted")
  // g9 (O6): while the sample is under review, say when its posting no longer meets the job criteria.
  const criteriaNoteId = useId()
  const criteriaReason = isAwaiting || review.submitting ? criteriaNoteReason(posting.data) : null
  const violated = posting.data?.eligibility?.rules.find((r) => r.result === "violated")
  const outcome =
    review.result && app.data
      ? sampleOutcome(review.result, {
          company,
          requisitionId: app.data.requisitionId,
          violatedRule: violated ? jobPostingCopy.ruleLabel[violated.rule] : null,
          submission: submission.data,
          postingPath: `/postings/${app.data.jobPostingId}`,
          paused: status.data?.globalPaused ?? false,
        })
      : null

  return (
    <AppShell advancedOnly>
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-4 px-4 lg:px-6">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link to="/activation" />}>{g.title}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbPage className="truncate">{app.data ? name : "…"}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        {hasErrorCode(app.error, "not_found") ? (
          <p>{applicationCopy.notFound.text}</p>
        ) : app.isError || submission.isError ? (
          <LoadErrorAlert onRetry={() => void Promise.all([app.refetch(), submission.refetch()])} />
        ) : !app.data || !submission.data ? (
          <SampleReviewSkeleton />
        ) : (
          <>
            <header className="flex flex-col gap-2">
              <h1 tabIndex={-1} className="text-2xl font-bold tracking-tight [overflow-wrap:anywhere]">
                {name}
              </h1>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                {submission.data.state || isSampleSubmitting(submission.data) ? <SubmissionStatusBadge submission={submission.data} /> : <ApplicationStatusBadge state={app.data.state} />}
                {app.data.careerProfileVersion !== null && <span>{applicationCopy.profileVersion(app.data.careerProfileVersion)}</span>}
                {app.data.applicationUrl && <EmployerPageLink href={app.data.applicationUrl} />}
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm sm:max-w-xl">
                <dt className="text-muted-foreground">{jobPostingCopy.requisitionLabel}</dt>
                <dd className="min-w-0 font-mono text-[13px] [overflow-wrap:anywhere]">{app.data.requisitionId}</dd>
                {posting.data && (
                  <>
                    <dt className="text-muted-foreground">{jobPostingCopy.applicationSystemLabel}</dt>
                    <dd>{posting.data.applicationSystem}</dd>
                  </>
                )}
              </dl>
              {posting.data && posting.data.unverifiedLabels.length > 0 && <UnverifiedLabels labels={posting.data.unverifiedLabels} />}
            </header>
            {outcome ? (
              <SampleOutcomeAlert key={review.attempt} outcome={outcome} />
            ) : (
              review.submitting && <SampleOutcomeAlert outcome={{ title: null, line: sc.approving, countLine: null, link: null, tone: "neutral" }} />
            )}
            {review.stalled && <p className="text-sm text-muted-foreground">{sc.stillSubmitting}</p>}
            {criteriaReason && <SampleCriteriaNote id={criteriaNoteId} reason={criteriaReason} />}
            {isAwaiting && <MissingAnswerWarning applicationId={applicationId} />}
            {isAwaiting && <SampleActionBar review={review} company={company} approveDescribedBy={criteriaReason ? criteriaNoteId : undefined} />}
            {sample?.state === "rejected" && sample.rejectReason && (
              <p className="text-sm [overflow-wrap:anywhere]">
                <span className="text-muted-foreground">{sc.rejectReasonLabel}</span> {sample.rejectReason}
              </p>
            )}
            {/* A sample awaiting review can still get fresh documents (after a new Career Profile version, say);
                the server refuses once it is approved or in submission. */}
            {isAwaiting && submission.data.state === null && app.data.state === "documents_ready" && (
              <GenerateDocumentsButton applicationId={applicationId} isRetry />
            )}
            {app.data.state === "generating" && (
              <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
                {applicationCopy.writing}
              </p>
            )}
            <div className="grid gap-4 xl:grid-cols-12">
              <div className="flex min-w-0 flex-col gap-4 xl:col-span-7">
                <DocumentsViewer documents={app.data.documents} coverLetterStatus={app.data.coverLetterStatus} initialTab="resume" name={name} />
                <FormAnswersPanel applicationId={applicationId} company={company} />
              </div>
              <div className="flex min-w-0 flex-col gap-4 xl:col-span-5">
                {posting.data?.eligibility && <EligibilityPanel eligibility={posting.data.eligibility} employmentType={posting.data.employmentType} />}
                {posting.data?.match && <MatchPanel match={posting.data.match} />}
              </div>
            </div>
          </>
        )}
      </div>
    </AppShell>
  )
}
