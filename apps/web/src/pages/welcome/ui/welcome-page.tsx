import { useId, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Navigate } from "react-router-dom"

import { AppShell } from "@/components/app-shell"
import { aiProviderQueryOptions } from "@/entities/ai-provider"
import { contactQueryOptions, CONTACT_NAME_MAX } from "@/entities/candidate-settings"
import {
  careerProfileQueryOptions,
  DroppedItemsLine,
  dropZoneDraftingFailure,
  ProfileSections,
  uploadCopy,
  type ProfileVersion,
} from "@/entities/career-profile"
import { ConsentLine } from "@/features/approve-ai-provider"
import { useUseThisProfile } from "@/features/approve-career-profile"
import { CareerProfileEditor } from "@/features/edit-career-profile"
import { contactFormCopy } from "@/features/edit-contact-details"
import { DraftingStatus, ResumeDropZone } from "@/features/upload-resume"
import { useDocumentTitle } from "@/shared/lib/use-document-title"
import { Button } from "@/shared/ui/button"
import { ButtonSpinner } from "@/shared/ui/button-spinner"
import { FieldDescription, FieldError, FieldLabel } from "@/shared/ui/field"
import { Input } from "@/shared/ui/input"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { Section, SectionStack } from "@/shared/ui/section"
import { Skeleton } from "@/shared/ui/skeleton"

/**
 * Upload (`/welcome`, R2): the one onboarding screen. Consent line, resume drop target, then, once
 * drafted, the facts to check and "Use this profile". Composes the existing upload, review and
 * approval features; the only extra field is the contact full name document generation needs.
 */
export function WelcomePage() {
  useDocumentTitle(uploadCopy.title)
  const profile = useQuery(careerProfileQueryOptions())
  const provider = useQuery(aiProviderQueryOptions())
  const contact = useQuery(contactQueryOptions())

  if (profile.data?.inUse && !profile.data.draft && !profile.data.drafting) return <Navigate to="/dashboard" replace />
  if (profile.data?.inUse && profile.data.draft) return <Navigate to="/profile" replace />

  return (
    <AppShell title={uploadCopy.title} description={uploadCopy.description}>
      <div className="flex w-full max-w-[760px] flex-col gap-7 px-4 lg:px-6">
        {profile.isError || provider.isError ? (
          <LoadErrorAlert
            onRetry={() => {
              if (profile.isError) void profile.refetch()
              if (provider.isError) void provider.refetch()
            }}
          />
        ) : profile.data && provider.data ? (
          <SectionStack>
            <Section title={uploadCopy.sectionResume} headingProps={{ tabIndex: -1 }}>
              <div className="flex flex-col gap-4">
                <ConsentLine />
                {profile.data.drafting?.status === "drafting" ? (
                  <ReadingStatus filename={profile.data.drafting.filename} startedAt={profile.data.drafting.startedAt} />
                ) : !profile.data.draft ? (
                  <ResumeDropZone
                    isAiProviderApproved={provider.data.approval !== null}
                    draftingFailure={dropZoneDraftingFailure(profile.data)}
                    welcome={{ prompt: uploadCopy.dropPrompt, choose: uploadCopy.dropChoose, helper: uploadCopy.dropHelper }}
                  />
                ) : null}
              </div>
            </Section>
            {profile.data.draft && !profile.data.drafting && (
              <Review draft={profile.data.draft} contactName={contact.data?.fullName ?? ""} contactReady={contact.isSuccess} contact={contact.data} />
            )}
          </SectionStack>
        ) : (
          <Skeleton className="h-40 w-full" />
        )}
      </div>
    </AppShell>
  )
}

/** State B: reading. A polite live region plus the existing drafting line. */
function ReadingStatus({ filename, startedAt }: { filename: string; startedAt: string }) {
  return (
    <div className="flex flex-col gap-3">
      <p role="status" aria-live="polite" className="sr-only">
        {uploadCopy.reading}
      </p>
      <DraftingStatus filename={filename} startedAt={startedAt} />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  )
}

/** State C: the drafted facts and the single filled button. */
function Review({
  draft,
  contactName,
  contactReady,
  contact,
}: {
  draft: ProfileVersion
  contactName: string
  contactReady: boolean
  contact: Parameters<typeof useUseThisProfile>[1]
}) {
  const id = useId()
  const nameRef = useRef<HTMLInputElement>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [name, setName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const approval = useUseThisProfile(draft, contact)
  const value = name ?? contactName

  const submit = () => {
    const trimmed = value.trim()
    if (trimmed === "") {
      setError(contactFormCopy.nameMissing)
      nameRef.current?.focus()
      return
    }
    if (trimmed.length > CONTACT_NAME_MAX) {
      setError(contactFormCopy.nameTooLong)
      nameRef.current?.focus()
      return
    }
    setError(null)
    approval.use(trimmed)
  }

  return (
    <Section title={uploadCopy.reviewHeading} description={uploadCopy.reviewIntro} headingProps={{ tabIndex: -1 }}>
      <div className="flex flex-col gap-5">
        <DroppedItemsLine count={draft.droppedFactCount} />
        {isEditing ? (
          <CareerProfileEditor sections={draft.sections} onClose={() => setIsEditing(false)} />
        ) : (
          <>
            <ProfileSections sections={draft.sections} invalidFactIds={approval.refusedFactIds} invalidFactMessage="Add text to this fact, or remove it." />
            <div>
              <Button variant="ghost" size="sm" onClick={() => setIsEditing(true)}>
                {uploadCopy.editFacts}
              </Button>
            </div>
          </>
        )}
        {!isEditing && (
          <>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor={`${id}-name`}>{contactFormCopy.nameLabel}</FieldLabel>
              <Input
                ref={nameRef}
                id={`${id}-name`}
                autoComplete="name"
                value={value}
                disabled={!contactReady}
                aria-invalid={error ? true : undefined}
                aria-describedby={`${id}-name-help${error ? ` ${id}-name-error` : ""}`}
                onChange={(event) => setName(event.target.value)}
              />
              <FieldDescription id={`${id}-name-help`}>{uploadCopy.fullNameHelp}</FieldDescription>
              {error && <FieldError id={`${id}-name-error`}>{error}</FieldError>}
            </div>
            <div className="flex border-t pt-5 max-sm:[&>button]:w-full sm:justify-end">
              <Button aria-busy={approval.isPending} disabled={approval.isPending || !contactReady} onClick={submit}>
                {approval.isPending && <ButtonSpinner />}
                {approval.isPending ? uploadCopy.usingProfile : uploadCopy.useProfile}
              </Button>
            </div>
          </>
        )}
      </div>
    </Section>
  )
}
