import { createHash, randomUUID } from "node:crypto"

import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common"
import type {
  CareerProfileResponse,
  CareerProfileVersion,
  ResumeMediaType,
  SaveCareerProfileDraftRequest,
} from "@eve/contracts"

import { ModelGateway } from "../ai/model-gateway.js"
import { AiProviderRepository } from "../ai/ai-provider.repository.js"
import { APP_CONFIG } from "../config/config.module.js"
import type { AppConfig } from "../config/env.js"
import type { StoredSection } from "../db/schema.js"
import { type CandidateTx, TenantDatabase } from "../db/tenant-database.js"
import { refreshAtsFit } from "../ats/ats-fit-refresh.js"
import { ApiException } from "../http/api-exception.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { EXTRACTION_SYSTEM_PROMPT, buildVerifiedSections, extractedProfileSchema } from "./career-profile-draft.js"
import { toProfileResponse, toVersion } from "./career-profile-view.js"
import { CareerProfileRepository, type VersionRow } from "./career-profile.repository.js"
import { applyDraftEdits } from "./draft-edits.js"
import { storeResume } from "./resume-storage.js"
import { CandidateFiles } from "../files/candidate-files.js"
import { CandidateScope } from "../db/candidate-scope.js"
import { normaliseForQuote } from "./source-quote.js"

/**
 * Every section and fact repeats a verbatim sourceQuote, so the reply is often
 * several times the resume's length. 8,000 tokens cut off a two-page resume
 * mid-JSON (invalid_output). The timeout covers the larger reply at roughly
 * 250 output tokens per second and stays inside the dashboard's polling window.
 */
const EXTRACTION_TIMEOUT_MS = 240_000
const EXTRACTION_MAX_OUTPUT_TOKENS = 32_000

export type AcceptedResume = Readonly<{ filename: string; mediaType: ResumeMediaType; bytes: Buffer; text: string }>

@Injectable()
export class CareerProfileService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CareerProfileService.name)
  private readonly inFlight = new Set<Promise<void>>()

  constructor(
    private readonly repository: CareerProfileRepository,
    private readonly approvals: AiProviderRepository,
    private readonly gateway: ModelGateway,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly files: CandidateFiles,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tenant: TenantDatabase
  ) {}

  /**
   * A drafting run cut off by a restart can never finish; show it as failed.
   * Best effort: an unreachable database must not stop the api from booting
   * (health then reports 503), so a failure here is logged and skipped.
   * EPIC-0002 A1: only the Operator can draft until invites (slice C), so the
   * recovery runs in the Operator's scope.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.tenant.asOperator(async () => {
        const latest = await this.repository.latestUpload()
        if (latest?.status === "drafting" && this.inFlight.size === 0) {
          await this.repository.finishUpload(latest.id, { status: "failed", reason: "timed_out" }, this.clock.now())
        }
      })
      // 0029: fill ATS fit for postings evaluated before it, against the approved profile.
      await this.tenant.asOperator(async () => {
        const approved = await this.repository.findApproved()
        if (approved) await this.tenant.run((trx, candidateId) => refreshAtsFit(trx, candidateId, approved.sections as StoredSection[], { onlyMissing: true }))
      })
    } catch (error) {
      this.logger.warn(`Skipped interrupted-drafting recovery: ${error instanceof Error ? error.name : "unknown"}`)
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([...this.inFlight])
  }

  async read(): Promise<CareerProfileResponse> {
    const [versions, upload] = await Promise.all([this.repository.listVersions(), this.repository.latestUpload()])
    return toProfileResponse(versions, upload)
  }

  async readVersion(version: number): Promise<CareerProfileVersion> {
    const row = await this.repository.findVersion(version)
    if (!row) throw new ApiException("not_found")
    return toVersion(row)
  }

  /**
   * Checked before the upload is read, so nothing is stored or sent when
   * Anthropic is not approved (AC 1.2) or a draft already exists.
   */
  async assertCanDraftFromResume(): Promise<void> {
    if (!(await this.approvals.findApproval())) throw new ApiException("ai_provider_not_approved")
    if (!this.config.anthropic.apiKeyConfigured) throw new ApiException("ai_provider_not_configured")
    const profile = await this.read()
    if (profile.drafting?.status === "drafting") throw new ApiException("resume_drafting_in_progress")
    if (profile.draft) throw new ApiException("career_profile_draft_exists")
  }

  /** Stores the resume and starts drafting. Returns once the drafting state is recorded. */
  async draftFromResume(resume: AcceptedResume): Promise<CareerProfileResponse> {
    await this.assertCanDraftFromResume()
    const id = randomUUID()
    const startedAt = this.clock.now()
    const started = await this.repository.startUpload({
      id,
      original_filename: resume.filename,
      media_type: resume.mediaType,
      byte_size: resume.bytes.length,
      sha256: sha256(resume.bytes),
      storage_name: `${id}.${resume.mediaType === "application/pdf" ? "pdf" : "docx"}`,
      status: "drafting",
      failure_reason: null,
      started_at: startedAt,
      finished_at: null,
    })
    if (!started) throw new ApiException("resume_drafting_in_progress")
    try {
      await storeResume(this.files, CandidateScope.require(), id, resume.mediaType, resume.bytes)
    } catch (error) {
      // A server fault (QA-F2: unwritable volume), not an AI provider failure. Only the
      // errno code is logged: the path and message could carry the uploaded name.
      this.logger.error(`Could not store resume ${id}: ${errnoCode(error)}`)
      await this.repository.finishUpload(id, { status: "failed", reason: "storage_error" }, this.clock.now())
      throw new ApiException("resume_storage_unavailable")
    }
    const task = this.runDrafting(id, resume.text).finally(() => this.inFlight.delete(task))
    this.inFlight.add(task)
    return this.read()
  }

  /** Waits for drafting started by this process. Used by shutdown and tests. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.inFlight])
  }

  async saveDraft(request: SaveCareerProfileDraftRequest): Promise<CareerProfileVersion> {
    const row = await this.repository.inVersionLock(async (trx) => {
      if ((await this.repository.latestUpload(trx))?.status === "drafting") throw new ApiException("resume_drafting_in_progress")
      const draft = await this.repository.findDraft(trx)
      const base = draft ?? (await this.repository.findApproved(trx))
      const sections = applyDraftEdits(base?.sections ?? [], request, randomUUID)
      if (draft) return this.repository.replaceDraftSections(trx, draft.version, sections)
      return this.repository.insertDraft(trx, {
        version: await this.repository.nextVersion(trx),
        source: "edit",
        resumeUploadId: null,
        sections,
        rejectedFacts: 0,
        createdAt: this.clock.now(),
      })
    })
    return toVersion(row)
  }

  async approveDraft(version: number): Promise<CareerProfileResponse> {
    await this.repository.inVersionLock(async (trx) => {
      const draft = await this.currentDraft(trx, version)
      if (hasEmptyFact(draft.sections)) throw new ApiException("career_profile_fact_empty")
      await this.repository.approve(trx, draft.version, this.clock.now())
      // ATS fit follows the approved profile: every posting's fit, and so the Ranked order, is recomputed.
      await refreshAtsFit(trx, CandidateScope.require(), draft.sections as StoredSection[])
    })
    return this.read()
  }

  async discardDraft(version: number | undefined): Promise<void> {
    await this.repository.inVersionLock(async (trx) => {
      const draft = await this.repository.findDraft(trx)
      if (!draft || (version !== undefined && draft.version !== version)) throw new ApiException("not_found")
      await this.repository.deleteDraft(trx, draft.version)
    })
  }

  /** The approved version new Tailored Documents use, or undefined. Drafts are never returned. */
  async versionInUse(): Promise<CareerProfileVersion | undefined> {
    const row = await this.repository.findApproved()
    return row ? toVersion(row) : undefined
  }

  private async currentDraft(trx: CandidateTx, version: number): Promise<VersionRow> {
    const draft = await this.repository.findDraft(trx)
    if (!draft || draft.version !== version) throw new ApiException("not_found")
    return draft
  }

  private async runDrafting(uploadId: string, resumeText: string): Promise<void> {
    try {
      const result = await this.gateway.generateObject({
        purpose: "career_profile_extraction",
        system: EXTRACTION_SYSTEM_PROMPT,
        prompt: `<resume>\n${resumeText}\n</resume>`,
        schema: extractedProfileSchema,
        maxOutputTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
        timeoutMs: EXTRACTION_TIMEOUT_MS,
        // Once per upload, and every Tailored Document is written from it: the stronger documents model.
        // The scoring model cut bullets at the PDF's line breaks and dropped their results (2026-11-01).
        tier: "documents",
        effort: "medium",
        resumeUploadId: uploadId,
        cost: { action: "Career Profile drafting" },
      })
      if (!result.ok) {
        await this.repository.finishUpload(uploadId, { status: "failed", reason: result.failure }, this.clock.now())
        return
      }
      const verified = buildVerifiedSections(result.object, normaliseForQuote(resumeText), randomUUID)
      if (verified.sections.length === 0) {
        await this.repository.finishUpload(uploadId, { status: "failed", reason: "no_verified_facts" }, this.clock.now())
        return
      }
      await this.repository.inVersionLock(async (trx) => {
        // A draft saved while the model call ran wins; this is not a provider failure (CR2-06).
        if (await this.repository.findDraft(trx)) {
          await this.repository.finishUpload(uploadId, { status: "failed", reason: "draft_exists" }, this.clock.now(), trx)
          return
        }
        await this.repository.insertDraft(trx, {
          version: await this.repository.nextVersion(trx),
          source: "resume",
          resumeUploadId: uploadId,
          sections: verified.sections,
          rejectedFacts: verified.rejectedFacts,
          createdAt: this.clock.now(),
        })
        await this.repository.finishUpload(uploadId, { status: "drafted" }, this.clock.now(), trx)
      })
    } catch (error) {
      this.logger.error(`Drafting ${uploadId} failed: ${error instanceof Error ? error.name : "unknown"}`)
      await this.repository
        .finishUpload(uploadId, { status: "failed", reason: "provider_error" }, this.clock.now())
        .catch(() => undefined)
    }
  }
}

function errnoCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" ? code : error instanceof Error ? error.name : "unknown"
}

function hasEmptyFact(sections: readonly StoredSection[]): boolean {
  return sections.some((section) => section.facts.some((fact) => fact.text.trim() === ""))
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}
