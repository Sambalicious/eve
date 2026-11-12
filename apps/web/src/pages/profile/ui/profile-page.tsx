import { useState, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeft, Info, FileQuestion } from "lucide-react"
import { useSearchParams } from "react-router-dom"

import { AppShell } from "@/components/app-shell"
import { aiProviderQueryOptions } from "@/entities/ai-provider"
import {
  careerProfileCopy,
  careerProfileQueryOptions,
  DroppedItemsLine,
  dropZoneDraftingFailure,
  resumeNotUsedFilename,
  profileVersionQueryOptions,
  ProfileSections,
  VersionStatusBadge,
  type CareerProfile,
  type ProfileVersion,
} from "@/entities/career-profile"
import {
  ApproveDraftButton,
  useApproveCareerProfile,
} from "@/features/approve-career-profile"
import {
  CareerProfileEditor,
  DiscardDraftButton,
} from "@/features/edit-career-profile"
import { DraftingStatus, ResumeDropZone } from "@/features/upload-resume"
import { hasErrorCode } from "@/shared/api"
import { formatWatDate } from "@/shared/lib/format-wat"
import { useDocumentTitle } from "@/shared/lib/use-document-title"
import { Alert, AlertDescription } from "@/shared/ui/alert"
import { Button } from "@/shared/ui/button"
import { ButtonLink } from "@/shared/ui/button-link"
import { QuietEmpty } from "@/shared/ui/section"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { ProfileSkeleton } from "@/components/page-skeletons"
import { canReplaceResume, canUploadResume, toProfileView } from "../model/profile-view"
import { VersionHistory } from "./version-history"

/** Career Profile (`/profile`): upload, review, approve, edit, version history. */
export function ProfilePage() {
  useDocumentTitle(careerProfileCopy.pageTitle)
  const [searchParams] = useSearchParams()
  const viewedVersion = Number(searchParams.get("version")) || null
  const profile = useQuery(careerProfileQueryOptions())
  const aiProvider = useQuery(aiProviderQueryOptions())

  return (
    <AppShell title={careerProfileCopy.pageTitle} description={careerProfileCopy.pageDescription}>
      <div className="flex w-full max-w-[960px] flex-col gap-7 px-4 lg:px-6">
        {profile.isError || aiProvider.isError ? (
          <LoadErrorAlert
            onRetry={() => {
              if (profile.isError) void profile.refetch()
              if (aiProvider.isError) void aiProvider.refetch()
            }}
          />
        ) : profile.data && aiProvider.data ? (
          viewedVersion ? (
            <ReadOnlyVersion version={viewedVersion} />
          ) : (
            <CareerProfileContent
              profile={profile.data}
              isAiProviderApproved={aiProvider.data.approval !== null}
            />
          )
        ) : (
          <ProfileSkeleton />
        )}
      </div>
    </AppShell>
  )
}

function CareerProfileContent({
  profile,
  isAiProviderApproved,
}: {
  profile: CareerProfile
  isAiProviderApproved: boolean
}) {
  const [isEditing, setIsEditing] = useState(false)
  const view = toProfileView(profile)

  return (
    <>
      {profile.drafting?.status === "drafting" && (
        <DraftingStatus
          filename={profile.drafting.filename}
          startedAt={profile.drafting.startedAt}
        />
      )}
      {canUploadResume(profile) && (
        <ResumeDropZone
          isAiProviderApproved={isAiProviderApproved}
          draftingFailure={dropZoneDraftingFailure(profile)}
        />
      )}
      {view.kind === "first-draft" && (
        <FirstDraft
          draft={view.draft}
          resumeNotUsed={resumeNotUsedFilename(profile)}
        />
      )}
      {view.kind === "approved" &&
        (isEditing ? (
          <EditMode version={view.inUse} onClose={() => setIsEditing(false)} />
        ) : (
          <ApprovedVersion
            inUse={view.inUse}
            onEdit={() => setIsEditing(true)}
          />
        ))}
      {view.kind === "later-draft" &&
        (isEditing ? (
          <EditMode version={view.draft} onClose={() => setIsEditing(false)} />
        ) : (
          <LaterDraft
            draft={view.draft}
            inUse={view.inUse}
            resumeNotUsed={resumeNotUsedFilename(profile)}
            onEdit={() => setIsEditing(true)}
          />
        ))}
      {!isEditing && canReplaceResume(profile) && (
        <section aria-labelledby="replace-resume-title" className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 id="replace-resume-title" className="text-base font-semibold">
              {careerProfileCopy.replaceTitle}
            </h2>
            <p className="text-sm text-muted-foreground">{careerProfileCopy.replaceText}</p>
          </div>
          <ResumeDropZone isAiProviderApproved={isAiProviderApproved} draftingFailure={dropZoneDraftingFailure(profile)} />
        </section>
      )}
      {!isEditing && <VersionHistory history={profile.history} />}
    </>
  )
}

function VersionHeader({ version }: { version: ProfileVersion }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <VersionStatusBadge status={version.status} />
      <span className="text-sm font-medium tabular-nums">
        {careerProfileCopy.versionLabel(version.version)}
      </span>
    </div>
  )
}

/** Version summary (DESIGN.md): status, version and a meta line on the left, actions on the right, one rule under it. */
function VersionBar({
  version,
  meta,
  actions,
}: {
  version: ProfileVersion
  meta?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b pb-5">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <VersionHeader version={version} />
        {meta && (
          <p className="text-[0.8125rem] text-muted-foreground">{meta}</p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  )
}

function Notice({ children }: { children: string }) {
  return (
    <Alert role="note">
      <Info aria-hidden="true" />
      <AlertDescription className="text-foreground">
        {children}
      </AlertDescription>
    </Alert>
  )
}

/**
 * C-PROFILE-17 (QA-2B-03): an info notice, not an error. A resume finished
 * drafting after the Candidate had saved a draft, so it wasn't used. Its
 * "Discard draft" opens C-CONFIRM-17. `filename` is "" when the API gave none.
 */
function ResumeNotUsedNotice({
  filename,
  draftVersion,
}: {
  filename: string
  draftVersion: number
}) {
  const text = careerProfileCopy.resumeNotUsed(filename || null)
  return (
    <Alert role="status" aria-label={text}>
      <Info aria-hidden="true" />
      <AlertDescription className="flex flex-col items-start gap-1 text-foreground">
        <span>{text}</span>
        <DiscardDraftButton version={draftVersion} appearance="link" />
      </AlertDescription>
    </Alert>
  )
}

/** Version 1, drafted from the resume: "Draft" badge, C-PROFILE-3, "Approve Career Profile". */
function FirstDraft({
  draft,
  resumeNotUsed,
}: {
  draft: ProfileVersion
  resumeNotUsed: string | null
}) {
  const approval = useApproveCareerProfile(draft)
  return (
    <section
      aria-label={careerProfileCopy.versionLabel(draft.version)}
      className="flex flex-col gap-4"
    >
      <VersionBar version={draft} />
      <Notice>{careerProfileCopy.draftNotice}</Notice>
      {resumeNotUsed !== null && (
        <ResumeNotUsedNotice
          filename={resumeNotUsed}
          draftVersion={draft.version}
        />
      )}
      <DroppedItemsLine count={draft.droppedFactCount} />
      <ProfileSections
        sections={draft.sections}
        invalidFactIds={approval.refusedFactIds}
        invalidFactMessage={careerProfileCopy.emptyFact}
      />
      {/* Spec F1 step 3: the Candidate reads every fact, then approves. */}
      <div className="flex flex-wrap gap-2 border-t pt-5">
        <ApproveDraftButton
          draft={draft}
          onRequestApproval={approval.requestApproval}
          isConfirming={approval.isConfirming}
          onConfirmingChange={approval.setIsConfirming}
          onConfirm={approval.confirm}
          isApproving={approval.isApproving}
        />
      </div>
    </section>
  )
}

function ApprovedVersion({
  inUse,
  onEdit,
}: {
  inUse: ProfileVersion
  onEdit: () => void
}) {
  return (
    <section
      aria-label={careerProfileCopy.versionLabel(inUse.version)}
      className="flex flex-col gap-4"
    >
      <VersionBar
        version={inUse}
        meta={
          inUse.approvedAt &&
          careerProfileCopy.approved(formatWatDate(inUse.approvedAt))
        }
        actions={
          <Button variant="outline" onClick={onEdit}>
            {careerProfileCopy.editProfile}
          </Button>
        }
      />
      <ProfileSections sections={inUse.sections} />
    </section>
  )
}

/** Version n > 1: C-PROFILE-6, C-PROFILE-7, "Approve version {n}", "Discard draft". */
function LaterDraft({
  draft,
  inUse,
  resumeNotUsed,
  onEdit,
}: {
  draft: ProfileVersion
  inUse: ProfileVersion
  resumeNotUsed: string | null
  onEdit: () => void
}) {
  const approval = useApproveCareerProfile(draft)
  return (
    <section
      aria-label={careerProfileCopy.versionLabel(draft.version)}
      className="flex flex-col gap-4"
    >
      <VersionBar
        version={draft}
        meta={
          inUse.approvedAt &&
          careerProfileCopy.inUseLine(
            inUse.version,
            formatWatDate(inUse.approvedAt)
          )
        }
        actions={
          <>
            <ApproveDraftButton
              draft={draft}
              onRequestApproval={approval.requestApproval}
              isConfirming={approval.isConfirming}
              onConfirmingChange={approval.setIsConfirming}
              onConfirm={approval.confirm}
              isApproving={approval.isApproving}
            />
            <Button variant="outline" onClick={onEdit}>
              {careerProfileCopy.continueEditing}
            </Button>
            <DiscardDraftButton version={draft.version} />
          </>
        }
      />
      <Notice>{careerProfileCopy.draftVersionNotice(draft.version)}</Notice>
      {resumeNotUsed !== null && (
        <ResumeNotUsedNotice
          filename={resumeNotUsed}
          draftVersion={draft.version}
        />
      )}
      <DroppedItemsLine count={draft.droppedFactCount} />
      <ProfileSections
        sections={draft.sections}
        invalidFactIds={approval.refusedFactIds}
        invalidFactMessage={careerProfileCopy.emptyFact}
      />
    </section>
  )
}

function EditMode({
  version,
  onClose,
}: {
  version: ProfileVersion
  onClose: () => void
}) {
  return (
    <section
      aria-label={careerProfileCopy.editProfile}
      className="flex flex-col gap-4"
    >
      <VersionBar version={version} />
      <CareerProfileEditor sections={version.sections} onClose={onClose} />
    </section>
  )
}

/** One version, read-only, from "Version history" or a "Career Profile version {n}" link. */
function ReadOnlyVersion({ version }: { version: number }) {
  const query = useQuery(profileVersionQueryOptions(version))
  if (hasErrorCode(query.error, "not_found"))
    return <VersionNotFound version={version} />
  return (
    <section
      aria-label={careerProfileCopy.versionLabel(version)}
      className="flex flex-col gap-4"
    >
      <div>
        <ButtonLink variant="ghost" size="sm" to="/profile">
          <ArrowLeft aria-hidden="true" />
          {careerProfileCopy.backToProfile}
        </ButtonLink>
      </div>
      {query.isError ? (
        <LoadErrorAlert onRetry={() => void query.refetch()} />
      ) : query.data ? (
        <>
          <DroppedItemsLine count={query.data.droppedFactCount} />
          <VersionHeader version={query.data} />
          <ProfileSections sections={query.data.sections} />
        </>
      ) : (
        <ProfileSkeleton />
      )}
    </section>
  )
}

/** C-PROFILE-16: an empty state with one action back to the page. */
function VersionNotFound({ version }: { version: number }) {
  const copy = careerProfileCopy.versionNotFound
  return (
    <QuietEmpty
      icon={<FileQuestion />}
      title={copy.title}
      description={copy.text(version)}
      action={
        <ButtonLink variant="outline" to="/profile">
          {copy.action}
        </ButtonLink>
      }
    />
  )
}
