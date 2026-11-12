import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { FileQuestion, Hand, Info, LoaderCircle, TriangleAlert, UserRound } from "lucide-react"
import { Link, useLocation, useNavigate, useParams } from "react-router-dom"

import { AppShell } from "@/components/app-shell"
import {
  DocumentBlockedAlert,
  DocumentsViewer,
  howSent,
  statusLine,
  SubmissionEvidence,
} from "@/components/application-record"
import { EligibilityPanel, MatchPanel } from "@/components/posting-evidence"
import {
  applicationCopy,
  applicationName,
  applicationsQueryKey,
  boardUiCopy,
  applicationQueryOptions,
  ApplicationStatusBadge,
  dropLine,
  failureCopy,
  type ApplicationDetailFocusState,
  OverrideBadge,
  overrideCopy,
  PastedApplicationBadge,
  pastedApplicationCopy,
  overrideFactValue,
  overrideInactiveBody,
  showsOverrideInactive,
  submissionCopy,
  submissionQueryOptions,
  SubmissionStatusBadge,
  type ApplicationDetail,
  type DocumentKind,
  type Submission,
} from "@/entities/application"
import {
  employmentTypeLabel,
  EmployerPageLink,
  jobPostingCopy,
  jobPostingQueryOptions,
  pastedWarning,
  PastedWarningPanel,
  UnverifiedLabels,
} from "@/entities/job-posting"
import { isAdvancedOn, useViewer } from "@/entities/viewer"
import { finalStatusLabel, recordCopy, requisitionRecordsQueryOptions } from "@/entities/requisition-record"
import { expiryNote, fillCopy, retentionCopy } from "@/entities/retention"
import { ClearRecordButton } from "@/features/clear-requisition-record"
import { DeleteRecordsMenu } from "@/features/delete-detailed-records"
import { GenerateDocumentsButton } from "@/features/generate-documents"
import { OutcomesList } from "@/features/record-outcome"
import { RemoveFromQueue, useRemoveFromQueue } from "@/features/remove-from-queue"
import { FormAnswersPanel } from "@/features/review-sample"
import { OutreachSection } from "@/features/outreach-messages"
import { hasErrorCode } from "@/shared/api"
import { formatWatDate, formatWatDateTime, watToday } from "@/shared/lib/format-wat"
import { useDocumentTitle } from "@/shared/lib/use-document-title"
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/shared/ui/breadcrumb"
import { ButtonLink } from "@/shared/ui/button-link"
import { QuietEmpty } from "@/shared/ui/section"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { ApplicationDetailSkeleton } from "@/components/page-skeletons"

/**
 * Application detail (`/applications/:applicationId`), the parts slice 4
 * supports: header (status, dates, "Career Profile version {n}"), Unverified
 * labels, Eligibility and Match (read from the Job Posting the Application
 * came from), employment type, and Documents with `#resume` / `#cover-letter`.
 * Slice 5 adds the submission status badge, "how it was sent", the status line
 * (queued again, queued for tomorrow, not submitted, declined with its
 * reason) and the Evidence card. Slice 7 adds the Answers table (`#answers`,
 * the target of E1's "View the answers used", CR6-01), the Outcomes list with
 * "Record Outcome" and "Edit", the overflow menu with "Delete detailed
 * records" (C-CONFIRM-11), and the minimal record view once they are deleted.
 *
 * The breadcrumb parent is Applications (design-review.r1 F5).
 */
export function ApplicationDetailPage() {
  const { applicationId = "" } = useParams()
  const query = useQuery({
    ...applicationQueryOptions(applicationId),
    retry: (count, error) => !hasErrorCode(error, "not_found") && count < 3,
  })
  const app = query.data
  const name = app ? applicationName(app) : "Application"
  useDocumentTitle(name)
  /**
   * AC 12.1: a 404 from an Outreach route means the details went while the page
   * was open. The swap to the minimal record view moves focus to its `h1`, the
   * same focus-on-arrival the page already gives the title after "Prepare anyway".
   */
  const [focusDeletedTitle, setFocusDeletedTitle] = useState(false)
  const handleDetailsDeleted = useCallback(() => setFocusDeletedTitle(true), [])

  if (hasErrorCode(query.error, "not_found")) return <NotFound />
  return (
    <AppShell>
      <div className="flex w-full max-w-[1120px] flex-col gap-4 px-4 lg:px-6">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link to="/applications" />}>
                {applicationCopy.applicationsBreadcrumb}
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbPage className="truncate">
                {app ? name : "…"}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        {query.isError ? (
          <LoadErrorAlert onRetry={() => void query.refetch()} />
        ) : app?.detailsDeletedAt ? (
          <MinimalRecordView app={app} deletedAt={app.detailsDeletedAt} focusTitle={focusDeletedTitle} />
        ) : app ? (
          <ApplicationRecord app={app} onDetailsDeleted={handleDetailsDeleted} />
        ) : (
          <ApplicationDetailSkeleton />
        )}
      </div>
    </AppShell>
  )
}

function ApplicationRecord({ app, onDetailsDeleted }: { app: ApplicationDetail; onDetailsDeleted: () => void }) {
  const advanced = isAdvancedOn(useViewer())
  const posting = useQuery(jobPostingQueryOptions(app.jobPostingId))
  // PD-4.3 (MO:147): the decision comes from GET /v1/job-postings/{id}; a 404 (no longer held) shows no warning.
  const warning = posting.data ? pastedWarning(posting.data) : null
  const submission = useQuery(submissionQueryOptions(app.id)).data
  const sent = submission ? howSent(submission) : null
  const line = submission ? statusLine(app, submission) : null
  const initialTab = useHashTab()
  const queryClient = useQueryClient()
  // A 404 from any outreach route means the details are gone: the record read decides what shows,
  // and focus follows to the minimal view's title (AC 12.1).
  const outreachUnavailable = useCallback(() => {
    onDetailsDeleted()
    void queryClient.invalidateQueries({ queryKey: applicationsQueryKey })
  }, [onDetailsDeleted, queryClient])
  useFocusHash(app.state === "documents_ready", submission !== undefined)
  const titleRef = useFocusTitleOnArrival()
  // "Generate again" also redoes ready documents (after a new Career Profile version, say) until the
  // Application enters submission; a sample awaiting review still can, as nothing has been sent.
  const canGenerate =
    app.state === "prepared" ||
    app.state === "documents_blocked" ||
    (app.state === "documents_ready" &&
      submission !== undefined &&
      (submission.state === null || (submission.state === "blocked" && submission.blocked?.reason === "ats_below_minimum")))
  return (
    <>
      <header className="flex flex-col gap-4 border-b pb-6">
        <div className="flex items-start justify-between gap-3">
          <h1
            ref={titleRef}
            tabIndex={-1}
            className="min-w-0 font-display text-[1.75rem] leading-[1.15] font-semibold tracking-[-0.02em] outline-none [overflow-wrap:anywhere] md:text-[2rem]"
          >
            {applicationName(app)}
          </h1>
          <div className="shrink-0 pt-1">
            <DeleteRecordsMenu applicationId={app.id} role={app.roleTitle ?? app.requisitionId} company={app.company ?? app.requisitionId} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
          {submission?.state ? (
            <SubmissionStatusBadge submission={submission} plain={!advanced} />
          ) : (
            <ApplicationStatusBadge state={app.state} />
          )}
          {app.override && <OverrideBadge />}
          {app.pastedDescription && <PastedApplicationBadge />}
          {app.careerProfileVersion !== null && (
            <span>
              {applicationCopy.profileVersion(app.careerProfileVersion)}
            </span>
          )}
          <span className="text-muted-foreground">
            Created{" "}
            <time dateTime={app.createdAt}>{formatWatDate(app.createdAt)}</time>
          </span>
          {app.applicationUrl && <EmployerPageLink href={app.applicationUrl} />}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          {/* v1.27.0: a pasted Application's requisition ID is synthetic, never shown. */}
          {!app.pastedDescription && (
            <div className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">
                {jobPostingCopy.requisitionLabel}
              </dt>
              <dd className="min-w-0 font-mono text-[13px] [overflow-wrap:anywhere]">
                {app.requisitionId}
              </dd>
            </div>
          )}
          {sent && (
            <div className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">
                {submissionCopy.detail.howSentLabel}
              </dt>
              <dd>{sent}</dd>
            </div>
          )}
          {submission?.submittedAt && (
            <div className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">
                {submissionCopy.detail.submittedLabel}
              </dt>
              <dd>
                <time dateTime={submission.submittedAt}>
                  {formatWatDateTime(submission.submittedAt)}
                </time>
              </dd>
            </div>
          )}
          {posting.data?.employmentType && (
            <div className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">
                {jobPostingCopy.employmentTypeLabel}
              </dt>
              <dd>{employmentTypeLabel[posting.data.employmentType]}</dd>
            </div>
          )}
          {app.override && (
            // C-AA-16 / C-AA-17 or C-AA-18: spans 2 columns because the reason can be long (B3).
            <div className="col-span-2 flex min-w-0 flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">{overrideCopy.label}</dt>
              <dd className="min-w-0 [overflow-wrap:anywhere]">
                <DatedText text={overrideFactValue(app.override, formatWatDate(app.override.createdAt))} date={formatWatDate(app.override.createdAt)} dateTime={app.override.createdAt} />
              </dd>
            </div>
          )}
          {app.expiresOn && <ExpiryItem expiresOn={app.expiresOn} app={app} submission={submission} />}
        </dl>
        {posting.data && posting.data.unverifiedLabels.length > 0 && (
          <UnverifiedLabels labels={posting.data.unverifiedLabels} />
        )}
        {line && <p className="text-sm text-pretty">{line}</p>}
        {/* AA-5.1: every queued Application with details (Queued, for tomorrow, again, until you resume). */}
        {/* PD-4.1: a manual-only Application never offers queue or sample actions. */}
        {submission?.state === "queued" && app.detailsDeletedAt === null && !app.manualOnly && <RemoveFromQueueAction app={app} />}
        {submission?.state === "declined" && submission.declinedReason && (
          <div className="text-sm">
            <p className="text-muted-foreground">
              {submissionCopy.detail.yourReason}
            </p>
            <blockquote className="border-l-2 pl-3 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {submission.declinedReason}
            </blockquote>
          </div>
        )}
      </header>
      {app.pastedDescription && <ManualOnlyNotice applicationUrl={app.applicationUrl} />}
      {warning && <PastedWarningPanel warning={warning} body={pastedApplicationCopy.warningBody} />}
      {/* The show rules need the submission state, so nothing shows until it has loaded. */}
      {submission && <OverrideNotice app={app} submission={submission} />}
      {submission && <SubmissionEvidence submission={submission} plain={!advanced} />}
      {app.blocked && (
        <DocumentBlockedAlert
          document={app.blocked.document}
          claim={app.blocked.claim}
          cause={app.blocked.cause}
          terms={app.blocked.terms}
          moreTerms={app.blocked.moreTerms}
        />
      )}
      {app.state === "documents_failed" ? (
        <FailureAlert app={app} />
      ) : (
        canGenerate && (
          <GenerateDocumentsButton
            applicationId={app.id}
            isRetry={app.state !== "prepared"}
          />
        )
      )}
      {app.state === "generating" && (
        <p
          role="status"
          aria-live="polite"
          className="text-sm text-muted-foreground"
        >
          {applicationCopy.writing}
        </p>
      )}
      {app.state === "prepared" && (
        <p className="text-sm text-muted-foreground">
          {applicationCopy.noDocumentsYet}
        </p>
      )}
      {app.state === "documents_ready" && app.documents.length > 0 && (
        <nav aria-label={boardUiCopy.documents.heading} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <a href="#resume" className="underline underline-offset-4">
            {boardUiCopy.documents.resume}
          </a>
          <a href="#cover-letter" className="underline underline-offset-4">
            {boardUiCopy.documents.coverLetter}
          </a>
        </nav>
      )}
      <div className="grid gap-x-12 gap-y-7 xl:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-7 xl:col-span-7">
          <DocumentsViewer
            documents={app.documents}
            coverLetterStatus={app.coverLetterStatus}
            initialTab={initialTab}
            name={applicationName(app)}
          />
          {/* Design r2 B3 (DR-03): a manual-only Application's form is never read, so no Answers used card. */}
          {!app.manualOnly && (
            <FormAnswersPanel applicationId={app.id} company={app.company ?? app.requisitionId} title={ANSWERS_TITLE} showHelp={false} />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-7 border-t pt-7 xl:col-span-5 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-8">
          <OutreachSection
            applicationId={app.id}
            applicationName={applicationName(app)}
            roleTitle={app.roleTitle}
            company={app.company}
            onUnavailable={outreachUnavailable}
          />
          {posting.data?.eligibility && (
            <EligibilityPanel eligibility={posting.data.eligibility} employmentType={posting.data.employmentType} />
          )}
          {posting.data?.match && <MatchPanel match={posting.data.match} />}
          <OutcomesList applicationId={app.id} />
        </div>
      </div>
    </>
  )
}

function RemoveFromQueueAction({ app }: { app: ApplicationDetail }) {
  const remove = useRemoveFromQueue(app.id)
  return (
    <RemoveFromQueue
      role={app.roleTitle}
      company={app.company}
      open={remove.open}
      inlineError={remove.inlineError}
      isPending={remove.isPending}
      onOpen={remove.openDialog}
      onClose={remove.close}
      onConfirm={remove.confirm}
    />
  )
}

/**
 * The first block under the header: the AA-4.5 "no longer applies" alert
 * (C-AA-20, body by `notAppliesReason`, link C-AA-22), or else the B3a drop
 * line (C-AA-40 / C-AA-41). Never both. Static: no live role.
 */
function OverrideNotice({ app, submission }: { app: ApplicationDetail; submission: Submission }) {
  if (app.override && showsOverrideInactive(app, submission)) {
    return (
      <Alert role={undefined}>
        <TriangleAlert aria-hidden="true" className="text-warning-text!" />
        <AlertTitle>{overrideCopy.inactiveTitle}</AlertTitle>
        <AlertDescription className="text-pretty">
          {overrideInactiveBody(app.override)}{" "}
          <Link to={`/postings/${app.jobPostingId}`} className="text-foreground underline underline-offset-4">
            {overrideCopy.inactiveLink}
          </Link>
        </AlertDescription>
      </Alert>
    )
  }
  const dropDate = app.latestDrop ? formatWatDate(app.latestDrop.at) : ""
  const line = app.latestDrop && dropLine(app, submission, dropDate)
  if (!line || !app.latestDrop) return null
  return (
    <p className="flex items-start gap-1.5 text-sm text-pretty text-muted-foreground">
      <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        <DatedText text={line} date={dropDate} dateTime={app.latestDrop.at} />
      </span>
    </p>
  )
}

/**
 * "Detailed records expire" (C-RET-13, C-RET-14), the header `dl`'s last item
 * while the details exist (B2). Past the date it adds "Kept until you decide."
 * (C-RET-15, warning + Hand) while a decision holds it, or "Deleted once the
 * current step finishes." (C-RET-15b, LoaderCircle) while it generates or
 * submits; with a suffix the value spans 2 columns.
 */
function ExpiryItem({ expiresOn, app, submission }: { expiresOn: string; app: ApplicationDetail; submission: Submission | undefined }) {
  const state = submission?.state
  const note = expiryNote({
    expiresOn,
    today: watToday(),
    waiting: state === "uncertain" || state === "blocked" || state === "queued" || submission?.sample?.state === "awaiting_review",
    inFlight: app.state === "generating" || state === "submit_claimed" || state === "submitting",
  })
  const date = <time dateTime={expiresOn}>{fillCopy(retentionCopy["application.expiry.value"], { date: formatWatDate(expiresOn) })}</time>
  return (
    <div className={note ? "col-span-2 flex min-w-0 flex-col gap-0.5" : "flex min-w-0 flex-col gap-0.5"}>
      <dt className="text-xs text-muted-foreground">{retentionCopy["application.expiry.label"]}</dt>
      {note === "waiting" ? (
        <dd className="flex items-start gap-1.5 text-warning-text">
          <Hand aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span className="text-pretty">{date}. {retentionCopy["application.expiry.waiting"]}</span>
        </dd>
      ) : note === "inFlight" ? (
        <dd className="flex items-start gap-1.5">
          <LoaderCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground motion-safe:animate-spin" />
          <span className="text-pretty">{date}. {retentionCopy["application.expiry.inFlight"]}</span>
        </dd>
      ) : (
        <dd className="tabular-nums">{date}</dd>
      )}
    </div>
  )
}

/** C-DOC-20 to C-DOC-29 (C-DOC-27 for an unknown reason), with the action each one names. */
function FailureAlert({ app }: { app: ApplicationDetail }) {
  const copy = failureCopy(app.failure)
  return (
    <Alert>
      <TriangleAlert aria-hidden="true" />
      <AlertTitle className="font-normal [overflow-wrap:anywhere]">
        {copy.line}
      </AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3 text-pretty [&_p:not(:last-child)]:mb-0">
        {copy.detail && <p>{copy.detail}</p>}
        {copy.action.kind === "generate" && (
          <GenerateDocumentsButton applicationId={app.id} isRetry />
        )}
        {copy.action.kind === "link" && (
          <ButtonLink to={copy.action.to} variant="outline">
            {copy.action.label}
          </ButtonLink>
        )}
      </AlertDescription>
    </Alert>
  )
}

/**
 * A copy sentence with only its formatted date inside `<time>` (deck a11y,
 * C-AA-17 and the drop line). The copy stays a single string from the deck;
 * the date is found in it rather than re-assembling the sentence here.
 */
function DatedText({ text, date, dateTime }: { text: string; date: string; dateTime: string }) {
  const at = date ? text.indexOf(date) : -1
  if (at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <time dateTime={dateTime}>{date}</time>
      {text.slice(at + date.length)}
    </>
  )
}

/**
 * After "Prepare anyway" the route carries `focusTitle` (design B3): focus the
 * title once the record renders, then clear the flag so a reload or Back
 * doesn't move focus again.
 */
function useFocusTitleOnArrival() {
  const ref = useRef<HTMLHeadingElement>(null)
  const location = useLocation()
  const navigate = useNavigate()
  const wantsFocus = (location.state as Partial<ApplicationDetailFocusState> | null)?.focusTitle === true
  useEffect(() => {
    if (!wantsFocus || !ref.current) return
    ref.current.focus()
    void navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null })
  }, [wantsFocus, navigate, location.pathname, location.search, location.hash])
  return ref
}

function useHashTab(): DocumentKind {
  const { hash } = useLocation()
  return hash === "#cover-letter" ? "cover_letter" : "resume"
}

/**
 * With `#resume`, `#cover-letter`, `#answers` or `#outcomes`, scroll to that
 * section and focus its heading (design-spec Accessibility). The document
 * headings exist once documents are ready; the others once the record shows.
 */
function useFocusHash(documentsReady: boolean, recordReady: boolean) {
  const { hash } = useLocation()
  useEffect(() => {
    const isDocument = hash === "#resume" || hash === "#cover-letter"
    const isSection = hash === "#answers" || hash === "#outcomes"
    if ((isDocument && !documentsReady) || (isSection && !recordReady) || (!isDocument && !isSection)) return
    const heading = document.getElementById(hash.slice(1))
    heading?.scrollIntoView?.({ block: "start" })
    heading?.focus()
  }, [hash, documentsReady, recordReady])
}

/**
 * Answers table heading. The design names the table "Answers used" without a
 * catalogue heading. OPEN[designer]: heading text for the Application page's Answers table.
 */
const ANSWERS_TITLE = "Answers used"

/**
 * Minimal record view (F10 retention, AC 10.4): company, employer application
 * URL, requisition ID, date and final status, C-DATA-3 and "Clear record".
 * Deleted by automatic expiry (the minimal record's `deletedBy`), the header
 * line is C-RET-19 instead of C-DATA-3 (B5). No expiry date is shown.
 * Opened from an email link (any section hash), it also says C-DATA-6.
 */
function MinimalRecordView({ app, deletedAt, focusTitle }: { app: ApplicationDetail; deletedAt: string; focusTitle: boolean }) {
  const advanced = isAdvancedOn(useViewer())
  const { hash } = useLocation()
  const record = useQuery(requisitionRecordsQueryOptions()).data?.find((r) => r.applicationId === app.id)
  const company = app.company ?? app.requisitionId
  const date = formatWatDate(deletedAt)
  // AC 12.1: the details went while the Candidate was inside the page, so focus
  // lands on the title of the view that replaced it. The same pattern as
  // `useFocusTitleOnArrival`, and it runs once, on arrival at this view.
  const titleRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (focusTitle) titleRef.current?.focus()
  }, [focusTitle])
  return (
    <>
      <header className="flex flex-col gap-3 border-b pb-6">
        <h1
          ref={titleRef}
          tabIndex={-1}
          className="font-display text-[1.75rem] leading-[1.15] font-semibold tracking-[-0.02em] outline-none [overflow-wrap:anywhere] md:text-[2rem]"
        >
          {company}
        </h1>
        {hash && <p className="text-sm text-pretty">{recordCopy.emailLinkDeleted(date)}</p>}
        <p className="text-sm text-pretty text-muted-foreground">
          {record?.deletedBy === "expiry" ? fillCopy(retentionCopy["application.minimal.deletedAutomatically"], { date }) : recordCopy.deletedOn(date)}
        </p>
      </header>
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <MinimalField label={recordCopy.columns.company}>{company}</MinimalField>
        {app.applicationUrl && (
          <MinimalField label={recordCopy.columns.url}>
            <span className="font-mono text-[13px] [overflow-wrap:anywhere]">{app.applicationUrl}</span>
          </MinimalField>
        )}
        {!app.pastedDescription && (
          <MinimalField label={recordCopy.columns.requisitionId}>
            <span className="font-mono text-[13px] [overflow-wrap:anywhere]">{app.requisitionId}</span>
          </MinimalField>
        )}
        <MinimalField label={recordCopy.columns.date}>
          <time dateTime={app.createdAt}>{formatWatDate(app.createdAt)}</time>
        </MinimalField>
        {record && <MinimalField label={recordCopy.columns.finalStatus}>{finalStatusLabel(record.finalStatus, !advanced)}</MinimalField>}
      </dl>
      <div>
        <ClearRecordButton applicationId={app.id} requisitionId={app.requisitionId} company={company} label={recordCopy.clearRecord} />
      </div>
    </>
  )
}

/** Design B3: C-PD-60 with C-PD-61 and the employer link, or C-PD-62 when there is no link. */
function ManualOnlyNotice({ applicationUrl }: { applicationUrl: string | null }) {
  return (
    <Alert role={undefined}>
      <UserRound aria-hidden="true" />
      <AlertTitle className="[overflow-wrap:anywhere]">{pastedApplicationCopy.manualOnlyTitle}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-1.5 [overflow-wrap:anywhere]">
        <p>{applicationUrl ? pastedApplicationCopy.manualOnlyBody : pastedApplicationCopy.manualOnlyBodyNoLink}</p>
        {applicationUrl && <EmployerPageLink href={applicationUrl} />}
      </AlertDescription>
    </Alert>
  )
}

function MinimalField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function NotFound() {
  return (
    <AppShell>
      <div className="flex max-w-[760px] px-4 lg:px-6">
        <QuietEmpty
          className="w-full"
          titleAs="h1"
          icon={<FileQuestion />}
          title={applicationCopy.notFound.title}
          description={applicationCopy.notFound.text}
          action={<ButtonLink to="/applications">Back to Applications</ButtonLink>}
        />
      </div>
    </AppShell>
  )
}
