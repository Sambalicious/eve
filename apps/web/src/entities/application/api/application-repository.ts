import {
  APPLICATIONS_PATH,
  applicationDetailSchema,
  applicationDocumentsGeneratePath,
  applicationPath,
  applicationSummarySchema,
  applicationsResponseSchema,
  createApplicationResponseSchema,
  DOCUMENTS_PATH,
  documentsListResponseSchema,
  blockedClaimCauseSchema,
  BLOCKED_CLAIM_TERMS_CAUSES,
  type ApplicationDetail as ApplicationDetailBody,
  type ApplicationListItem,
  type ApplicationSummary,
  type ApplicationsRetentionFilter,
  type DocumentsListResponse,
  type OverrideDecision as OverrideDecisionBody,
  type TailoredDocument as TailoredDocumentBody,
} from "@eve/contracts"

import { apiRequest } from "@/shared/api"
import type { Application, ApplicationDetail, DocumentFiles, DocumentsListRow } from "../model/application"

/** All Applications (newest first), or with `retention` exactly those due or waiting, earliest expiry first (E5.7). */
export async function fetchApplications(retention: ApplicationsRetentionFilter | null = null): Promise<Application[]> {
  const response = await apiRequest(retention ? `${APPLICATIONS_PATH}?retention=${retention}` : APPLICATIONS_PATH)
  return applicationsResponseSchema.parse(await response.json()).applications.map(toListApplication)
}

export async function fetchApplication(id: string): Promise<ApplicationDetail> {
  const response = await apiRequest(applicationPath(encodeURIComponent(id)))
  return toDetail(applicationDetailSchema.parse(await response.json()))
}

/**
 * `created: false` means the requisition already had an Application; it is returned.
 * v1.24.0 (AA-2.1): `acknowledgement` is the decision the override dialog showed, sent unchanged.
 */
export async function createApplication(
  jobPostingId: string,
  csrfToken: string,
  acknowledgement: Readonly<Omit<OverrideDecisionBody, "violatedRules">> & { readonly violatedRules: readonly string[] } | null = null
): Promise<{ created: boolean; application: Application }> {
  const json = acknowledgement
    ? { jobPostingId, acknowledgement: { confirmed: true as const, decision: { ...acknowledgement, violatedRules: [...acknowledgement.violatedRules] } } }
    : { jobPostingId }
  const response = await apiRequest(APPLICATIONS_PATH, { method: "POST", csrfToken, json })
  const body = createApplicationResponseSchema.parse(await response.json())
  return { created: body.created, application: toApplication(body.application) }
}

export async function generateDocuments(id: string, csrfToken: string): Promise<Application> {
  const response = await apiRequest(applicationDocumentsGeneratePath(encodeURIComponent(id)), { method: "POST", csrfToken })
  return toApplication(applicationSummarySchema.parse(await response.json()))
}

export async function fetchDocumentsList(): Promise<DocumentsListRow[]> {
  const response = await apiRequest(DOCUMENTS_PATH)
  return documentsListResponseSchema.parse(await response.json()).rows.map(toRow)
}

/**
 * Fetches a document with the session cookie and returns its bytes as a Blob.
 * The preview shows it from a `blob:` URL, as the contract advises.
 */
export async function fetchDocumentBlob(url: string): Promise<Blob> {
  const response = await apiRequest(url)
  return response.blob()
}

/** A list row: the Application plus the read-only board fields (C4). */
function toListApplication(body: ApplicationListItem): Application {
  return {
    ...toApplication(body),
    board: {
      submissionState: body.submissionState,
      submissionKind: body.submissionKind,
      sampleState: body.sampleState,
      latestOutcome: body.latestOutcome,
      requestForAction: body.requestForAction,
    },
  }
}

/**
 * EPIC-0009: the blocked alert's data. The cause is narrowed to a known value; an older api, a row
 * blocked before v1.30.0 and an unknown cause all become null, which shows the fallback message.
 * Terms are kept only for a cause that shows a list, so the response cannot make the alert lie.
 */
function blockedOf(body: ApplicationSummary): Application["blocked"] {
  if (body.state !== "documents_blocked" || !body.blockedDocument) return null
  const cause = blockedClaimCauseSchema.safeParse(body.blockedClaimCause)
  if (!cause.success) return { document: body.blockedDocument, claim: body.blockedClaim, cause: null, terms: null, moreTerms: null }
  const showsTerms = (BLOCKED_CLAIM_TERMS_CAUSES as readonly string[]).includes(cause.data)
  return {
    document: body.blockedDocument,
    claim: body.blockedClaim,
    cause: cause.data,
    terms: showsTerms ? (body.blockedClaimTerms ?? []) : null,
    moreTerms: showsTerms ? (body.blockedClaimMoreTerms ?? 0) : null,
  }
}

export function toApplication(body: ApplicationSummary): Application {
  return {
    id: body.id,
    jobPostingId: body.jobPostingId,
    company: body.company,
    roleTitle: body.roleTitle,
    requisitionId: body.requisitionId,
    applicationUrl: body.applicationUrl,
    pastedDescription: body.pastedDescription,
    manualOnly: body.manualOnly,
    state: body.state,
    careerProfileVersion: body.careerProfileVersion,
    blocked: blockedOf(body),
    failure: body.failure,
    coverLetterStatus: body.coverLetterStatus,
    createdAt: body.createdAt,
    updatedAt: body.updatedAt,
    detailsDeletedAt: body.detailsDeletedAt ?? null,
    expiresOn: body.expiresOn,
    override: body.override && { ...body.override, violatedRules: body.override.violatedRules && [...body.override.violatedRules] },
  }
}

function toDetail(body: ApplicationDetailBody): ApplicationDetail {
  return {
    ...toApplication(body),
    documents: body.documents.map((d) => ({ ...toFiles(d), previewText: [...d.previewText] })),
    posting: body.posting && { status: body.posting.status, hidden: body.posting.hidden },
    latestDrop: body.latestDrop && { at: body.latestDrop.at, reason: body.latestDrop.reason },
  }
}

function toFiles(d: Omit<TailoredDocumentBody, "previewText">): DocumentFiles {
  return { kind: d.kind, careerProfileVersion: d.careerProfileVersion, createdAt: d.createdAt, pdfUrl: d.pdfUrl, docxUrl: d.docxUrl, ats: d.ats ?? null }
}

function toRow(row: DocumentsListResponse["rows"][number]): DocumentsListRow {
  return {
    applicationId: row.applicationId,
    company: row.company,
    roleTitle: row.roleTitle,
    requisitionId: row.requisitionId,
    pastedDescription: row.pastedDescription,
    coverLetterStatus: row.coverLetterStatus,
    resume: row.resume && toFiles(row.resume),
    coverLetter: row.coverLetter && toFiles(row.coverLetter),
  }
}
