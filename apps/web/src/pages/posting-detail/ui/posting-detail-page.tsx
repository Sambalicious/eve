import { useQuery } from "@tanstack/react-query"
import { EyeOff, FileQuestion, Info } from "lucide-react"
import { useId } from "react"
import { Link, useParams } from "react-router-dom"

import { AppShell } from "@/components/app-shell"
import { EligibilityPanel, MatchPanel, TechnologiesPanel } from "@/components/posting-evidence"
import { postingName } from "@/components/posting-list"
import {
  AttributionLink,
  CHECKING_POLL_MS,
  isCheckingTooLong,
  waitingLine,
  EmployerPageLink,
  employmentTypeLabel,
  hiddenReasonHasSettingsLink,
  jobPostingCopy,
  jobPostingQueryOptions,
  PastedDescriptionBadge,
  pastedPostingCopy,
  pastedWarning,
  PastedWarningPanel,
  PostingAge,
  PostingStatusBadge,
  reasonLine,
  relevanceCopy,
  roleFamilyLabel,
  type HiddenReason,
  type JobPostingDetail,
} from "@/entities/job-posting"
import { isTechnologyCriterionOn, jobCriteriaQueryOptions } from "@/entities/candidate-settings"
import { preferencesQueryOptions } from "@/entities/job-preferences"
import { AnywayRefusalPanel, PrepareAnyway, PrepareDocumentsButton, usePrepareAnyway } from "@/features/prepare-application"
import { hasErrorCode } from "@/shared/api"
import { formatWatDate } from "@/shared/lib/format-wat"
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
import { Skeleton } from "@/shared/ui/skeleton"
import { PostingDetailSkeleton } from "@/components/page-skeletons"
import { PostingText } from "./posting-text"

/** Job Posting detail (`/postings/:postingId`): header, Eligibility panel, Match panel, posting text. */
export function PostingDetailPage() {
  const { postingId = "" } = useParams()
  const query = useQuery({
    ...jobPostingQueryOptions(postingId),
    retry: (count, error) => !hasErrorCode(error, "not_found") && count < 3,
    refetchInterval: (q) =>
      q.state.data?.status === "checking" &&
      !isCheckingTooLong(q.state.data.discoveredAt, new Date())
        ? CHECKING_POLL_MS
        : false,
  })
  const posting = query.data
  const title = posting ? postingName(posting) : jobPostingCopy.pageTitle
  useDocumentTitle(title)

  if (hasErrorCode(query.error, "not_found")) return <NotFound />
  return (
    <AppShell>
      <div className="flex w-full max-w-[1120px] flex-col gap-4 px-4 lg:px-6">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link to="/postings" />}>
                {jobPostingCopy.pageTitle}
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbPage className="truncate">
                {posting ? title : "…"}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        {query.isError ? (
          <LoadErrorAlert onRetry={() => void query.refetch()} />
        ) : posting ? (
          <PostingDetail posting={posting} />
        ) : (
          <PostingDetailSkeleton />
        )}
      </div>
    </AppShell>
  )
}

function PostingDetail({ posting }: { posting: JobPostingDetail }) {
  // Only the "m of n are in your criteria" line needs this; until it loads, that line is hidden.
  const criteria = useQuery(jobCriteriaQueryOptions())
  const criterionOn = criteria.data ? isTechnologyCriterionOn(criteria.data) : null
  const preferences = useQuery({ ...preferencesQueryOptions(), enabled: posting.skipReason === "keyword_mismatch" })
  const preferenceSkip = preferenceSkipLine(posting, preferences.data?.values.titleKeyword ?? null)
  const reason = preferenceSkip ?? reasonLine(posting)
  const now = new Date()
  // AC-3.8, 3.9: a hidden posting offers no action that starts an Application, whatever its stored status.
  // AA-6.4: "Prepare documents" only on a visible ranked posting with no Application.
  // EPIC-0010 PD-3.1: a pasted-description posting offers it exactly when the server says (`pastedPrepareOffered`).
  const canPrepare = posting.pastedDescription
    ? posting.pastedPrepareOffered
    : posting.status === "ranked" && posting.hiddenReason === null && posting.applicationId === null
  // PD-4.3: a skipped or excluded pasted posting warns instead of the reason alert (one panel, not two).
  const warning = pastedWarning(posting)
  const warningTitleId = useId()
  // AA-1.4: "Prepare documents anyway" only when the server offers it (`applyAnyway`); the client never decides.
  const anyway = usePrepareAnyway(posting)
  return (
    <>
      <header className="flex flex-col gap-5 border-b pb-6">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2.5">
            <h1
              tabIndex={-1}
              className="font-display text-[1.75rem] leading-[1.15] font-semibold tracking-[-0.02em] outline-none [overflow-wrap:anywhere] md:text-[2rem]"
            >
              {postingName(posting)}
            </h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
              <PostingStatusBadge posting={posting} />
              {posting.pastedDescription && <PastedDescriptionBadge />}
              <PostingAge postedDate={posting.postedDate} className="text-sm [&>svg]:size-3.5" />
              {posting.attribution && (
                <AttributionLink attribution={posting.attribution} />
              )}
              {!preferenceSkip && posting.applyUrl && <EmployerPageLink href={posting.applyUrl} />}
            </div>
            {preferenceSkip && (
              // DP-B1-09 (r4 B-POST-2 reading order): skip line, Change job preferences, then the employer page.
              <div className="flex flex-col items-start gap-2.5">
                <SkipReasonAlert text={preferenceSkip} />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
                  <ButtonLink to={jobPostingCopy.prefsHref} variant="ghost">
                    {jobPostingCopy.changePrefs}
                  </ButtonLink>
                  {posting.applyUrl && <EmployerPageLink href={posting.applyUrl} />}
                </div>
              </div>
            )}
          </div>
          {canPrepare ? (
            <div className="w-full sm:w-auto">
              <PrepareDocumentsButton
                jobPostingId={posting.id}
                role={posting.title}
                company={posting.company}
                describedBy={warning ? warningTitleId : undefined}
              />
            </div>
          ) : posting.applyAnyway || anyway.snapshot ? (
            // Kept mounted while its dialog is open, so a background refetch can't close it (snapshot rule).
            <div className="w-full sm:w-auto">
              <PrepareAnyway
                manual={posting.skipReason === "unsupported_application_system"}
                role={posting.title}
                company={posting.company}
                cap={anyway.cap}
                snapshot={anyway.snapshot}
                inlineError={anyway.inlineError}
                isPending={anyway.isPending}
                onOpen={anyway.open}
                onClose={anyway.close}
                onConfirm={anyway.confirm}
                shouldFocusHeading={anyway.shouldFocusHeading}
              />
            </div>
          ) : null}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          {/* v1.27.0: no system without a link; the pasted requisition ID is synthetic, never shown. */}
          {posting.applyUrl && (
            <Fact
              label={jobPostingCopy.applicationSystemLabel}
              value={posting.applicationSystem}
            />
          )}
          {!posting.pastedDescription && (
            <Fact
              label={jobPostingCopy.requisitionLabel}
              value={posting.requisitionId}
              mono
            />
          )}
          {posting.roleFamily && (
            <Fact
              label={jobPostingCopy.roleFamilyLabel}
              value={roleFamilyLabel[posting.roleFamily]}
            />
          )}
          {posting.employmentType && (
            <Fact
              label={jobPostingCopy.employmentTypeLabel}
              value={employmentTypeLabel[posting.employmentType]}
            />
          )}
          {posting.postedDate && (
            <Fact
              label={
                posting.postedDate.kind === "updated"
                  ? relevanceCopy.postingDetail.updated.label
                  : relevanceCopy.postingDetail.posted.label
              }
              value={formatWatDate(posting.postedDate.on)}
              dateTime={posting.postedDate.on}
            />
          )}
        </dl>
      </header>
      {anyway.refusal && <AnywayRefusalPanel message={anyway.refusal} />}
      {posting.hiddenReason && <HiddenNotice reason={posting.hiddenReason} />}
      {warning ? (
        <PastedWarningPanel
          warning={warning}
          titleId={warningTitleId}
          body={posting.applicationId === null ? pastedPostingCopy.warningBody : null}
        />
      ) : reason && !preferenceSkip && (
        <Alert
          variant={posting.status === "excluded" ? "destructive" : "default"}
        >
          <Info aria-hidden="true" />
          <AlertTitle className="font-normal [overflow-wrap:anywhere]">
            {reason}
          </AlertTitle>
        </Alert>
      )}
      {posting.status === "waiting_to_be_checked" ? (
        <p className="text-sm" aria-live="polite">
          {waitingLine(posting.discoveredAt, now)}
        </p>
      ) : posting.status === "checking" ? (
        <CheckingState tooLong={isCheckingTooLong(posting.discoveredAt, now)} />
      ) : (
        <div className="grid gap-x-12 gap-y-7 xl:grid-cols-12">
          <div className="flex min-w-0 flex-col gap-7 xl:col-span-8">
            {posting.eligibility && (
              <EligibilityPanel eligibility={posting.eligibility} employmentType={posting.employmentType} />
            )}
            {posting.match && <MatchPanel match={posting.match} />}
            <TechnologiesPanel
              technologies={posting.technologies}
              notChecked={posting.technologiesNotChecked}
              criterionOn={criterionOn}
            />
          </div>
          <div className="min-w-0 border-t pt-7 xl:col-span-4 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-8">
            <div>
              <PostingText
                text={posting.postingText}
                note={posting.pastedDescription ? pastedPostingCopy.textNote : undefined}
              />
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function SkipReasonAlert({ text }: { text: string }) {
  return (
    <Alert>
      <Info aria-hidden="true" />
      <AlertTitle className="font-normal [overflow-wrap:anywhere]">{text}</AlertTitle>
    </Alert>
  )
}

/**
 * B-POST-2: the detail line for a skip the Candidate's own preferences caused.
 * `skipDetail` is null for both reasons (v1.23.0); the keyword comes from the saved
 * `titleKeyword`, the family from `roleFamily`. Null for every other posting.
 */
function preferenceSkipLine(posting: JobPostingDetail, keyword: string | null): string | null {
  const copy = jobPostingCopy.detailSkip
  if (posting.status !== "skipped") return null
  if (posting.skipReason === "excluded_role_family") return copy.excludedFamily(roleFamilyLabel[posting.roleFamily ?? "other"])
  if (posting.skipReason === "keyword_mismatch") return keyword ? copy.keyword(keyword) : copy.keywordNoDetail
  return null
}

/** "Checking": skeleton rows in both panels, a polite status line, and C-ERR-4 after 10 minutes. */
function CheckingState({ tooLong }: { tooLong: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground" role="status">
        {tooLong ? jobPostingCopy.pollTimedOut : jobPostingCopy.status.checking}
      </p>
      {!tooLong &&
        ["Eligibility", "Match"].map((name) => (
          <div
            key={name}
            aria-hidden="true"
            className="flex flex-col gap-3 border-t pt-6 first:border-t-0"
          >
            <Skeleton className="h-4 w-28" />
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        ))}
    </div>
  )
}

/**
 * EPIC-0006 B6: why the posting is off the board. A static notice, no live role.
 * Links to Job criteria only for the setting-driven reasons (P15).
 */
function HiddenNotice({ reason }: { reason: HiddenReason }) {
  const copy = relevanceCopy.postingDetail.hidden
  return (
    <Alert role={undefined}>
      <EyeOff aria-hidden="true" />
      <AlertTitle className="font-normal [overflow-wrap:anywhere]">{copy.reason[reason]}</AlertTitle>
      <AlertDescription className="[overflow-wrap:anywhere]">
        {copy.body}
        {hiddenReasonHasSettingsLink(reason) && (
          <>
            {" "}
            <Link to={jobPostingCopy.criteria.settingsHref} className="text-foreground underline underline-offset-4">
              {copy.link}
            </Link>
          </>
        )}
      </AlertDescription>
    </Alert>
  )
}

function Fact({
  label,
  value,
  mono = false,
  dateTime,
}: {
  label: string
  value: string
  mono?: boolean
  /** Renders the value as `<time dateTime>`. */
  dateTime?: string
}) {
  return (
    <>
      <div className="flex min-w-0 flex-col gap-0.5">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd
          className={`min-w-0 [overflow-wrap:anywhere] ${mono ? "font-mono text-[13px]" : ""}`}
        >
          {dateTime ? <time dateTime={dateTime}>{value}</time> : value}
        </dd>
      </div>
    </>
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
          title={jobPostingCopy.notFound.title}
          description={jobPostingCopy.notFound.text}
          action={
            <ButtonLink to="/postings">
              {jobPostingCopy.notFound.action}
            </ButtonLink>
          }
        />
      </div>
    </AppShell>
  )
}
