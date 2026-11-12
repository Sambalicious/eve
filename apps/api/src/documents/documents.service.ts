import { createHash, randomUUID } from "node:crypto"

import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common"
import type {
  ApiErrorCode,
  ApplicationOverride,
  CreateApplicationRequest,
  LatestDrop,
  ApplicationsRetentionFilter,
  ApplicationDetail,
  ApplicationSummary,
  ApplicationsResponse,
  AtsMinimum,
  CandidateContact,
  CreateApplicationResponse,
  DocumentFormatValue,
  DocumentKindValue,
  DocumentsListResponse,
  TailoredDocument,
} from "@eve/contracts"
import type { ApplicationListItem } from "@eve/contracts"
import { documentDownloadPath, latestDropReasonOf, queuedPostingDroppedDetailSchema } from "@eve/contracts"
import type { Selectable } from "kysely"

import { ModelGateway } from "../ai/model-gateway.js"
import { APP_CONFIG } from "../config/config.module.js"
import type { SharedRuntimeConfig } from "../config/env.js"
import type { ApplicationTable, StoredSection, TailoredDocumentTable } from "../db/schema.js"
import { TenantDatabase } from "../db/tenant-database.js"
import { type LocalDate, watDate } from "../records/expiry-date.js"
import { expiresOn, matchesRetentionFilter, readGraceEnd } from "../records/retention-view.js"
import { ApiException } from "../http/api-exception.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { meaningKey } from "./line-text.js"
import { atsKeywords, containsKeyword, normaliseForAts, scoreAts } from "../ats/ats-score.js"
import { sentencesOf, storedDirectionQuotes } from "./company-direction.js"
import { storedTerms } from "./blocked-claim.js"
import { type LetterTarget, type LineKind, type PostingGuard, directionParagraphCount, dropOrphanDirection, dropUnsupportedSentences, fallBackToFactWording, hardFailCounts, isWholeParagraph, letterBlocksOnlyOnUnjudged, namesTarget, needsMeaningCheck, postingGuard, postingTerms, refusedSentence, sentencesOfLine, settleCappedLetter, validateDocument } from "./document-claims.js"
import { MEANING_CHECK_EFFORT, MEANING_CHECK_MAX_OUTPUT_TOKENS, MEANING_CHECK_PURPOSE, MEANING_CHECK_TIMEOUT_MS, type MeaningCheckItem, buildMeaningCheckPrompt, meaningCheckSchema, meaningCheckSystemPrompt, supportedTexts } from "./meaning-check.js"
import {
  GENERATION_EFFORT,
  aliasFacts,
  resolveFactIds,
  withRoleHeadings,
  GENERATION_MAX_OUTPUT_TOKENS,
  GENERATION_PURPOSE,
  generationSystemPrompt,
  GENERATION_TIMEOUT_MS,
  buildGenerationPrompt,
  emphasisThemes,
  factsOf,
  generatedDocumentsSchema,
  toCoverLetterContent,
  toResumeContent,
  withoutContactFacts,
} from "./document-generation.js"
import { type ContactHeader, type CoverLetterContent, type DocumentContent, type DocumentKind, type DocumentLine, type ResumeContent, plainTextOf } from "./document-model.js"
import { headlineDecision } from "./headline.js"
import { keywordDensity, repairDenseLines, resumeLineRefs } from "./keyword-density.js"
import { capLetterKeywords } from "./letter-keyword-cap.js"
import { STORAGE_NAME } from "./document-storage.js"
import { CandidateFiles } from "../files/candidate-files.js"
import { CandidateScope } from "../db/candidate-scope.js"
import { type CreateOutcome, DocumentsRepository, type StoredDocument } from "./documents.repository.js"
import { applicationOverride } from "./override.js"
import { manualPostingIds, overridesFor } from "./override-reader.js"
import { publicLink } from "../discovery/pasted-description-store.js"
import { renderDocx, renderPdf, verifyPdfText, wordIntegrity } from "./render.js"

export type GenerationOutcome = "ready" | "blocked" | "failed" | "busy"

@Injectable()
export class DocumentsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DocumentsService.name)
  private readonly inFlight = new Set<Promise<unknown>>()
  private readonly flags: Readonly<{ bridges: boolean; direction: boolean }>

  constructor(
    private readonly repository: DocumentsRepository,
    private readonly gateway: ModelGateway,
    private readonly files: CandidateFiles,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tenant: TenantDatabase,
    @Inject(APP_CONFIG) config: SharedRuntimeConfig
  ) {
    // EPIC-0012 (Revision 2, 2.4): both flags are off unless the config says exactly so.
    this.flags = { bridges: config.documentBridgesEnabled === true, direction: config.documentDirectionEnabled === true }
  }

  /**
   * F-QA4-02: one api process runs every generation, so at startup nothing can
   * be generating. Rows left in "generating" by a restart become retryable.
   * If the api ever runs as several replicas, move generation to a pg-boss job.
   * EPIC-0002 A1: system work, so it reads Candidate IDs from the identity
   * table and resets each Candidate's rows in that Candidate's scope.
   */
  async onApplicationBootstrap(): Promise<void> {
    // The api must still boot (and /v1/health answer 503) when the database is down, so a failed reset is
    // only logged. Retry is then refused for those rows until the next restart with a reachable database.
    try {
      const resets = await this.tenant.eachCandidate(() => this.repository.resetInterrupted(this.clock.now()))
      const reset = resets.reduce((sum, count) => sum + count, 0)
      if (reset > 0) this.logger.warn(`Reset ${reset} Application(s) interrupted while generating documents`)
      const swept = await this.sweepOrphans()
      if (swept > 0) this.logger.warn(`Removed ${swept} Tailored Document file(s) with no record`)
    } catch (error) {
      this.logger.error(`Could not reset interrupted generations: ${error instanceof Error ? error.name : "unknown"}`)
    }
  }

  /**
   * Scope item 1 and v1.24.0 apply anyway: a ranked Job Posting becomes an
   * Application, once per requisition; an overridable one only with an
   * acknowledgement of its current decision (api-contract.md "Order of checks").
   */
  async createApplication(request: CreateApplicationRequest): Promise<CreateApplicationResponse> {
    const result = await this.repository.createIfRanked(request.jobPostingId, request.acknowledgement?.decision ?? null, this.clock.now())
    if (result.outcome !== "ok") throw new ApiException(CREATE_REFUSAL[result.outcome])
    const row = await this.repository.findApplication(result.id)
    if (!row) throw new ApiException("internal_error")
    return { created: result.created, application: await this.summary(row) }
  }

  /**
   * E5.7: `retention` narrows the list to exactly the Applications counted in
   * `GET /v1/retention` (`due`: dueNext30Days, `waiting`: waitingForDecision),
   * earliest expiry first. Without it the list is unchanged (newest first, 500).
   */
  async list(retention: ApplicationsRetentionFilter | null = null): Promise<ApplicationsResponse> {
    const graceEnd = await this.graceEnd()
    if (retention === null) return { applications: await this.listItems(await this.repository.listApplications(), graceEnd) }
    const today = watDate(this.clock.now())
    const rows = (await this.repository.listLiveApplications())
      .filter((row) => matchesRetentionFilter(row, retention, today, graceEnd))
      .map((row) => ({ row, expiry: expiresOn(row, graceEnd)! }))
      .sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : a.row.created_at.getTime() - b.row.created_at.getTime() || (a.row.id < b.row.id ? -1 : 1)))
    return { applications: await this.listItems(rows.slice(0, 500).map(({ row }) => row), graceEnd) }
  }

  /** EPIC-0011 C4: the summaries plus the read-only board fields. A minimal record carries no Outcomes. */
  private async listItems(rows: readonly Selectable<ApplicationTable>[], graceEnd: LocalDate): Promise<ApplicationListItem[]> {
    const [summaries, outcomes] = await Promise.all([this.summaries(rows, graceEnd), this.repository.latestOutcomes(rows.filter((row) => row.details_deleted_at === null).map((row) => row.id))])
    return summaries.map((summary, index) => {
      const row = rows[index]!
      const found = outcomes.get(row.id)
      return {
        ...summary,
        submissionState: row.submission_state,
        submissionKind: row.submission_kind,
        sampleState: row.sample_state,
        latestOutcome: found?.latest ? { id: found.latest.id, type: found.latest.type, createdAt: found.latest.createdAt.toISOString() } : null,
        requestForAction: found?.requestForAction ?? false,
      }
    })
  }

  async detail(id: string): Promise<ApplicationDetail> {
    const row = await this.repository.findApplication(id)
    if (!row) throw new ApiException("not_found")
    const documents = await this.repository.listDocuments([id])
    const contact = await this.contactHeader()
    const facts = await this.repository.detailFacts(row, this.clock.now())
    const override = applicationOverride(row, facts.posting)
    return {
      ...summaryOf(row, await this.graceEnd(), override, await this.tenant.run((tx) => manualPostingIds(tx, [row.job_posting_id]))),
      documents: sortKinds(documents).map((document) => documentView(document, contact)),
      posting: row.details_deleted_at === null && facts.posting !== null ? { status: facts.posting.decision.status, hidden: facts.posting.hidden } : null,
      latestDrop: latestDropOf(row, override, facts.latestQueueEvent),
    }
  }

  async documentsList(): Promise<DocumentsListResponse> {
    const applications = await this.repository.listApplications()
    const documents = await this.repository.listDocuments(applications.map((row) => row.id))
    const rows = applications.flatMap((application) => {
      const own = documents.filter((document) => document.application_id === application.id)
      if (own.length === 0) return []
      const view = (kind: DocumentKind) => {
        const document = own.find((candidate) => candidate.kind === kind)
        if (!document) return null
        const { kind: documentKind, careerProfileVersion, createdAt, pdfUrl, docxUrl, ats } = documentView(document, null)
        return { kind: documentKind, careerProfileVersion, createdAt, pdfUrl, docxUrl, ats }
      }
      return [
        {
          applicationId: application.id,
          company: application.company,
          roleTitle: application.role_title,
          requisitionId: application.requisition_id,
          pastedDescription: isPastedRequisition(application.requisition_id),
          coverLetterStatus: application.cover_letter_status,
          resume: view("resume"),
          coverLetter: view("cover_letter"),
        },
      ]
    })
    return { rows }
  }

  /**
   * AC 5.1 to 5.4. Starts generation in the background and returns the
   * Application in "generating". Contact details must be set first, because
   * documents can't be rendered without the header.
   */
  async startGeneration(id: string): Promise<ApplicationSummary> {
    const row = await this.repository.findApplication(id)
    if (!row) throw new ApiException("not_found")
    if (row.details_deleted_at !== null) throw new ApiException("application_state_conflict")
    const contact = await this.repository.readContact()
    if (contact.full_name.trim() === "") throw new ApiException("contact_details_missing")
    if (!(await this.repository.startGenerating(id, this.clock.now()))) {
      return this.summary(row)
    }
    const task = this.generate(id)
      .catch((error: unknown) => {
        this.logger.error(`Document generation failed: ${error instanceof Error ? error.name : "unknown"}`)
        return this.repository.markFailed(id, "provider_error", this.clock.now())
      })
      .finally(() => this.inFlight.delete(task))
    this.inFlight.add(task)
    const started = await this.repository.findApplication(id)
    return this.summary(started ?? row)
  }

  /**
   * The meaning check: lines that fail the word check only on lower-case wording go to one model call.
   * Returns the memo keys it explicitly marked supported, and whether the call itself failed. Any failure
   * returns none, so nothing extra passes.
   */
  private async checkMeaning(
    applicationId: string,
    resume: ResumeContent,
    letter: CoverLetterContent,
    facts: ReadonlyMap<string, string>,
    wording: ReadonlyMap<string, string>,
    letterTarget: LetterTarget,
    contact: ContactHeader,
    posting: PostingGuard
  ): Promise<Readonly<{ supported: Set<string>; failed: boolean }>> {
    const resumeLines: ReadonlyArray<Readonly<{ line: DocumentLine; kind: LineKind }>> = [
      ...resume.summary.map((line) => ({ line, kind: "summary" as const })),
      ...resume.experience.flatMap((entry) => entry.bullets.map((line) => ({ line, kind: "experience_bullet" as const }))),
      ...resume.skills.map((line) => ({ line, kind: "skills" as const })),
    ]
    const items: MeaningCheckItem[] = [
      ...resumeLines.filter(({ line, kind }) => needsMeaningCheck(line, facts, null, contact, kind, posting, wording)),
      ...letter.paragraphs.map((line) => ({ line, kind: "letter_paragraph" as const })).filter(({ line, kind }) => needsMeaningCheck(line, facts, letterTarget, contact, kind, posting, wording)),
    ].map(({ line }) => ({ line, facts: line.factIds.map((factId) => facts.get(factId) ?? ""), postingTerms: postingTerms(line, facts, posting) }))
    if (items.length === 0) return { supported: new Set(), failed: false }
    const result = await this.gateway.generateObject({
      purpose: MEANING_CHECK_PURPOSE,
      system: meaningCheckSystemPrompt(this.flags),
      prompt: buildMeaningCheckPrompt(items, { bridges: this.flags.bridges }),
      schema: meaningCheckSchema,
      maxOutputTokens: MEANING_CHECK_MAX_OUTPUT_TOKENS,
      effort: MEANING_CHECK_EFFORT,
      timeoutMs: MEANING_CHECK_TIMEOUT_MS,
      applicationId,
      cost: { action: "document generation", haltOnGlobalPause: true },
    })
    if (!result.ok) {
      this.logger.log(JSON.stringify({ event: "documents.meaning_check_failed", applicationId, failure: result.failure }))
      return { supported: new Set(), failed: true }
    }
    const supported = supportedTexts(items, result.object)
    const postingTermItems = items.filter((item) => item.postingTerms.length > 0)
    const postingTermSupported = postingTermItems.filter((item) => supported.has(meaningKey(item.line.text, item.line.factIds))).length
    this.logger.log(
      JSON.stringify({
        event: "documents.meaning_checked",
        applicationId,
        checked: items.length,
        supported: supported.size,
        refused: items.length - supported.size,
        postingTermLines: this.flags.bridges ? postingTermItems.length : 0,
        postingTermSupported: this.flags.bridges ? postingTermSupported : 0,
      })
    )
    return { supported, failed: false }
  }

  /**
   * A paragraph the checker refused loses its good sentences with it: the verdict is about the paragraph, so
   * nothing inside it can be rescued. This second pass asks the same judge about the sentences of those
   * paragraphs only (they have two or more), and returns the paragraph verdicts plus the sentence ones. A
   * sentence the judge supports then survives its neighbour's refusal, which is what a Candidate sees.
   *
   * Null when there is nothing to ask about or the call fails: the caller then keeps the paragraph verdicts
   * alone and the letter blocks as it did before.
   */
  private async checkRefusedSentences(
    applicationId: string,
    letter: CoverLetterContent,
    judged: ReadonlySet<string>,
    facts: ReadonlyMap<string, string>,
    wording: ReadonlyMap<string, string>,
    letterTarget: LetterTarget,
    contact: ContactHeader,
    posting: PostingGuard
  ): Promise<Set<string> | null> {
    const refused = letter.paragraphs.filter(
      (paragraph) =>
        sentencesOf(paragraph.text).length > 1 &&
        !judged.has(meaningKey(paragraph.text, paragraph.factIds)) &&
        !isWholeParagraph(paragraph, posting) &&
        needsMeaningCheck(paragraph, facts, letterTarget, contact, "letter_paragraph", posting, wording)
    )
    if (refused.length === 0) return null
    const sentences = refused.flatMap((paragraph) => sentencesOfLine(paragraph)).filter((line) => needsMeaningCheck(line, facts, letterTarget, contact, "letter_paragraph", posting, wording))
    if (sentences.length === 0) return null
    const items: MeaningCheckItem[] = sentences.map((line) => ({ line, facts: line.factIds.map((factId) => facts.get(factId) ?? ""), postingTerms: postingTerms(line, facts, posting) }))
    const result = await this.gateway.generateObject({
      purpose: MEANING_CHECK_PURPOSE,
      system: meaningCheckSystemPrompt(this.flags),
      prompt: buildMeaningCheckPrompt(items, { bridges: this.flags.bridges }),
      schema: meaningCheckSchema,
      maxOutputTokens: MEANING_CHECK_MAX_OUTPUT_TOKENS,
      effort: MEANING_CHECK_EFFORT,
      timeoutMs: MEANING_CHECK_TIMEOUT_MS,
      applicationId,
      cost: { action: "document generation", haltOnGlobalPause: true },
    })
    if (!result.ok) {
      this.logger.log(JSON.stringify({ event: "documents.sentence_check_failed", applicationId, failure: result.failure }))
      return null
    }
    const supported = supportedTexts(items, result.object)
    this.logger.log(JSON.stringify({ event: "documents.sentences_checked", applicationId, checked: items.length, supported: supported.size, refused: items.length - supported.size }))
    return new Set([...judged, ...supported])
  }

  /** Waits for generations started by this process. Used by tests. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.inFlight])
  }

  /** The generation itself. Assumes the Application is in "generating". */
  async generate(id: string): Promise<GenerationOutcome> {
    const now = () => this.clock.now()
    const application = await this.repository.findApplication(id)
    if (!application) return "failed"
    const profile = await this.repository.approvedProfile()
    if (!profile) {
      await this.repository.markFailed(id, "no_career_profile", now())
      return "failed"
    }
    const posting = await this.repository.findPosting(application.job_posting_id)
    const contact = await this.contactHeader()
    const sections = withoutContactFacts(profile.sections as StoredSection[], contact)
    const target = { company: application.company, roleTitle: application.role_title, text: posting?.posting_text ?? "" }
    const aliased = aliasFacts(sections)
    // ATS: the posting's keywords, and those the profile states with the (aliased) facts that state them.
    const keywords = atsKeywords(posting?.technologies ?? null, posting?.ats_skills ?? null, application.company)
    const profileText = sections.flatMap((section) => [section.title, ...section.facts.map((fact) => fact.text)]).join("\n")
    const atsTargets = keywords.flatMap(({ keyword }) => {
      const stating = aliased.sections.flatMap((section) => section.facts.filter((fact) => containsKeyword(normaliseForAts(fact.text), keyword)).map((fact) => fact.id))
      return stating.length > 0 ? [{ keyword, factIds: stating.slice(0, 3) }] : []
    })
    // EPIC-0012 rule 2: the posting lends lower-case domain wording, never evidence. Gaps are keywords the
    // posting asks for and the profile does not state; a pasted posting has none until evaluated (risk R2).
    const normalisedProfile = normaliseForAts(profileText)
    // Direction off: no quotes reach the prompt or the guard, so a quoted span fails on its own words. The
    // forward statements stay stored on the posting row either way. Only a stored list of quotes is used:
    // the column is jsonb, and a value in another shape lends nothing (a letter must never quote non-quotes).
    const direction = this.flags.direction ? storedDirectionQuotes(posting?.forward_statements) : []
    const postingTermsGuard = postingGuard(
      posting?.posting_text ?? "",
      application.role_title,
      keywords.filter(({ keyword }) => !containsKeyword(normalisedProfile, keyword)).map(({ keyword }) => keyword),
      // Bridges off: the posting lends no terms (empty text), so the posting-terms path never runs. Gap skills,
      // borrowed names and role nouns are hard fails and still run.
      keywords.length > 0 && this.flags.bridges,
      // EPIC-0012 rule 4: the posting's verified forward-looking quotes, as stored. Only the generation prompt
      // drops the ones that name the target (design 2b); the guard gets them all, because a stored quote is
      // still a source. A letter that quotes one naming the employer is blocked by namesTarget, which reads
      // the full line before the span is stripped.
      direction
    )
    const result = await this.gateway.generateObject({
      purpose: GENERATION_PURPOSE,
      system: generationSystemPrompt(this.flags),
      prompt: buildGenerationPrompt(aliased.sections, target, emphasisThemes(aliased.sections), atsTargets, direction),
      schema: generatedDocumentsSchema,
      maxOutputTokens: GENERATION_MAX_OUTPUT_TOKENS,
      tier: "documents",
      effort: GENERATION_EFFORT,
      timeoutMs: GENERATION_TIMEOUT_MS,
      applicationId: id,
      cost: { action: "document generation", haltOnGlobalPause: true },
    })
    if (!result.ok && (result.failure === "paused" || result.failure === "cost_paused")) {
      // AC 10.1, 10.2: a pause is not an Anthropic failure and nothing was generated. The Application goes
      // back to `documents_ready` when its earlier documents are still stored, else to `prepared`, so
      // "Generate" works again once the pause ends. The dashboard shows the pause from GET /v1/controls.
      await this.repository.markPaused(id, now())
      return "failed"
    }
    if (!result.ok) {
      await this.repository.markFailed(id, result.failure, now())
      return "failed"
    }
    const generated = resolveFactIds(result.object, aliased.realId)
    const facts = new Map(sections.flatMap((section) => factsOf(section)))
    const letterTarget = { employer: application.company ?? "", roleTitle: application.role_title ?? "" }
    const sectionOfFact = new Map(sections.flatMap((section) => section.facts.map((fact) => [fact.id, section.id] as const)))
    const wording = new Map(sections.flatMap((section) => section.facts.map((fact) => [fact.id, fact.text] as const)))
    const draftResume = withRoleHeadings(toResumeContent(generated.resume, (factId) => sectionOfFact.get(factId)), sections, contact)
    const draftLetter = toCoverLetterContent(generated.coverLetter, target)
    // EPIC-0012 Revision 2, 2.3: count-only monitoring of the hard fails on the model's draft. Reasons and
    // counts only, never line text, facts or posting words.
    const hardFails = hardFailCounts(draftResume, draftLetter, facts, letterTarget, contact, postingTermsGuard, wording)
    const hardFailTotal = Object.values(hardFails).reduce((sum, count) => sum + count, 0)
    if (hardFailTotal > 0) this.logger.log(JSON.stringify({ event: "documents.hard_fail", applicationId: id, total: hardFailTotal, reasons: hardFails }))
    const meaning = await this.checkMeaning(id, draftResume, draftLetter, facts, wording, letterTarget, contact, postingTermsGuard)
    // A refused paragraph is asked about sentence by sentence, so one unsupported sentence no longer takes its
    // neighbours down with it. Null (nothing to ask, or that call failed) leaves the paragraph verdicts alone.
    const sentenceVerdicts = meaning.failed ? null : await this.checkRefusedSentences(id, draftLetter, meaning.supported, facts, wording, letterTarget, contact, postingTermsGuard)
    const meaningChecked = sentenceVerdicts ?? meaning.supported
    const tailoredResume = fallBackToFactWording(draftResume, facts, wording, contact, meaning.supported, postingTermsGuard)
    const tailoredLetter = dropUnsupportedSentences(draftLetter, facts, letterTarget, contact, meaningChecked, postingTermsGuard, wording)
    // The letter's verdicts after the trim: the judged sentences plus one carved verdict per kept subset.
    const judgedLetter = tailoredLetter.checked
    // EPIC-0012 Revision 2 addendum, A6: a paragraph left holding only the quoted direction sentence says
    // nothing about the Candidate, so it is dropped unless it is the letter's last body paragraph.
    const orphaned = dropOrphanDirection(tailoredLetter.letter, postingTermsGuard)
    const letterSentencesDropped = tailoredLetter.dropped + orphaned.dropped
    if (letterSentencesDropped > 0) this.logger.log(JSON.stringify({ event: "documents.letter_sentences_dropped", applicationId: id, count: letterSentencesDropped }))
    if (tailoredResume.replaced > 0) this.logger.log(JSON.stringify({ event: "documents.lines_fell_back", applicationId: id, count: tailoredResume.replaced }))
    // EPIC-0012 Revision 2, 2.3: one direction-use record per letter, only when the flag is on and the prompt
    // offered at least one quote (the quotes not naming the employer or role). Flags and counts only.
    if (this.flags.direction && direction.length > 0) {
      const offered = direction.filter((quote) => !namesTarget(quote, letterTarget)).length
      if (offered > 0) {
        const draftUsed = directionParagraphCount(draftLetter, postingTermsGuard) > 0
        const used = directionParagraphCount(orphaned.letter, postingTermsGuard) > 0 ? 1 : 0
        this.logger.log(JSON.stringify({ event: "documents.direction_used", applicationId: id, offered, used, judgedSupported: draftUsed ? used === 1 : null, orphan: orphaned.orphan ? 1 : 0 }))
      }
    }
    // EPIC-0012 rule 3 (Revision 2, R14): the letter holds at most three mentions of one keyword. From the
    // fourth on, the sentence holding it is dropped and a paragraph left empty is dropped while another
    // remains. The letter's last body sentence is never dropped. Revision 3 (R17): a trimmed paragraph that
    // fails its own claim check is dropped, or takes its untrimmed form back when it is all that is left, so
    // the cap never blocks and never waves text through.
    const cappedLetter = capLetterKeywords(orphaned.letter, keywords)
    const settledLetter = settleCappedLetter(cappedLetter, facts, letterTarget, contact, judgedLetter, postingTermsGuard, wording)
    if (cappedLetter.dropped > 0 || settledLetter.paragraphsDropped > 0 || cappedLetter.overCap || settledLetter.restored > 0) {
      this.logger.log(
        JSON.stringify({
          event: "documents.letter_keyword_cap",
          applicationId: id,
          mentions: cappedLetter.mentions,
          dropped: cappedLetter.dropped,
          paragraphsDropped: settledLetter.paragraphsDropped,
          overCap: cappedLetter.overCap || settledLetter.restored > 0,
        })
      )
    }
    // A paragraph the cap trimmed keeps the verdict of the paragraph it came from: the remaining sentences
    // are a subset of judged sentences. Hard fails still run on the trimmed text in the validation below.
    const finalChecked = settledLetter.checked
    // EPIC-0012 rule 3: a repeated keyword, or a line packed with keywords, falls back to its plain fact
    // wording. Stuffing never blocks; the score below is taken on the repaired text.
    const density = keywordDensity(resumeLineRefs(tailoredResume.resume), keywords)
    let finalResume = tailoredResume.resume
    if (density.lineIds.length > 0) {
      const repaired = repairDenseLines(finalResume, density.lineIds, wording)
      finalResume = repaired.resume
      this.logger.log(JSON.stringify({ event: "documents.keyword_density", applicationId: id, flagged: density.lineIds.length, repeated: density.repeated.length, crowded: density.crowdedLineIds.length, repaired: repaired.replaced }))
    }
    // EPIC-0012 rule 1: the headline is backend text, set here and never written by the model. It prints the
    // posting's role title only when one approved experience title holds every meaningful word of it. Partial
    // overlap prints nothing; only the count of words the profile does not support is logged.
    const headline = headlineDecision(application.role_title, sections.filter((section) => section.kind === "experience").map((section) => section.title))
    if (headline.headline === null && headline.missing > 0) {
      this.logger.log(JSON.stringify({ event: "documents.headline_unsupported", applicationId: id, missing: headline.missing }))
    }
    finalResume = { ...finalResume, headline: headline.headline }
    // Scored on exactly what will be stored and printed, after every check.
    const ats = scoreAts(keywords, plainTextOf(finalResume, contact).join("\n"), profileText)
    this.logger.log(JSON.stringify({ event: "documents.ats_scored", applicationId: id, score: ats.score, total: ats.total, missing: ats.missing.length, gaps: ats.gaps.length }))
    const documents: Array<[DocumentKind, DocumentContent]> = [
      ["resume", { ...finalResume, ats }],
      ["cover_letter", settledLetter.letter],
    ]
    for (const [kind, content] of documents) {
      const validation = validateDocument(content, facts, kind === "cover_letter" ? letterTarget : null, contact, finalChecked, postingTermsGuard, wording)
      if (!validation.ok) {
        // EPIC-0012 Revision 2, R16: a failed judge call must not become a claim block when the letter
        // blocks only on reworded lines it never judged. That is a retryable provider error.
        if (kind === "cover_letter" && meaning.failed && letterBlocksOnlyOnUnjudged(settledLetter.letter, facts, letterTarget, contact, finalChecked, postingTermsGuard, wording)) {
          await this.repository.markFailed(id, "provider_error", now())
          return "failed"
        }
        // The claim a Candidate sees is the sentence that failed, not the paragraph that held it: a
        // paragraph of three sentences with one unsupported line names that line alone.
        const sentence = kind === "cover_letter" ? refusedSentence(settledLetter.letter, facts, letterTarget, contact, finalChecked, postingTermsGuard, wording) : null
        const blocked = sentence === null ? validation : { ...validation, claim: sentence }
        await this.removeFiles(await this.repository.markBlocked(id, profile.version, kind, blocked, now()))
        return "blocked"
      }
    }
    const stored: StoredDocument[] = []
    for (const [kind, content] of documents) {
      const pdf = await renderPdf(content, contact)
      const check = await verifyPdfText(pdf, content, contact)
      // Second check (F-QA4-03): the same layout, uncompressed, has no word split by a positioning offset.
      const words = wordIntegrity(await renderPdf(content, contact, { compress: false }), content, contact)
      if (!check.ok || !words.ok) {
        await this.repository.markFailed(id, "render_check_failed", now())
        return "failed"
      }
      const docx = await renderDocx(content, contact)
      const fileId = randomUUID()
      const candidateId = CandidateScope.require()
      try {
        stored.push({
          kind,
          content,
          pdfStorageName: await this.storeFile(candidateId, `${fileId}.pdf`, pdf),
          docxStorageName: await this.storeFile(candidateId, `${fileId}.docx`, docx),
          pdfSha256: sha256(pdf),
          docxSha256: sha256(docx),
        })
      } catch (error) {
        // F-QA4-01: a file-system failure (EACCES, ENOSPC, EROFS) is not a provider error.
        this.logger.error(`Storing a Tailored Document failed: ${error instanceof Error && "code" in error ? String(error.code) : "unknown"}`)
        await this.removeFiles([...stored.flatMap((done) => [done.pdfStorageName, done.docxStorageName]), `${fileId}.pdf`])
        await this.repository.markFailed(id, "storage_error", now())
        return "failed"
      }
    }
    const written = stored.flatMap((done) => [done.pdfStorageName, done.docxStorageName])
    let outcome: { recorded: boolean; remove: string[] }
    try {
      outcome = await this.repository.recordDocuments(id, profile.version, stored, now())
    } catch (error) {
      // SEC-408: the transaction rolled back, so nothing references the new files.
      await this.removeFiles(written)
      throw error
    }
    await this.removeFiles(outcome.remove)
    // An automatic submission held below the ATS minimum goes back to the queue once its new resume reaches it.
    if (outcome.recorded) await this.repository.requeueAtsHeld(now(), id)
    return outcome.recorded ? "ready" : "failed"
  }

  /**
   * SEC-408: at startup (no generation can be running), remove stored files
   * named `<uuid>.pdf|docx` that no tailored_document row references, such as
   * files written by a generation a restart cut off. Other files are left alone.
   */
  private async sweepOrphans(): Promise<number> {
    // EPIC-0002 A2: one directory per Candidate, compared with that Candidate's own rows.
    const counts = await this.tenant.eachCandidate(async (candidateId) => {
      const names = await this.files.list(candidateId, "documents").catch(() => [] as string[])
      const referenced = await this.repository.referencedStorageNames()
      const orphans = names.filter((name) => STORAGE_NAME.test(name) && !referenced.has(name))
      await this.removeFiles(orphans)
      return orphans.length
    })
    return counts.reduce((sum, count) => sum + count, 0)
  }

  private async storeFile(candidateId: string, name: string, bytes: Buffer): Promise<string> {
    await this.files.write(candidateId, "documents", name, bytes)
    return name
  }

  /** Removes the scope Candidate's document files by the names the server chose. */
  private async removeFiles(names: readonly string[]): Promise<void> {
    const candidateId = CandidateScope.require()
    await Promise.all(names.map((name) => this.files.remove(candidateId, "documents", name).catch(() => undefined)))
  }

  async download(id: string, kind: DocumentKindValue, format: DocumentFormatValue): Promise<{ bytes: Buffer; filename: string }> {
    const application = await this.repository.findApplication(id)
    if (!application || application.state !== "documents_ready") throw new ApiException("document_not_available")
    const document = await this.repository.findDocument(id, kind)
    if (!document) throw new ApiException("document_not_available")
    const bytes = await this.files.read(CandidateScope.require(), "documents", format === "pdf" ? document.pdf_storage_name : document.docx_storage_name)
    return { bytes, filename: downloadName(application, kind, format) }
  }

  /** v1.26.0 (ATS): the Candidate's minimum ATS match for automatic submission (default 40 without a row). */
  async atsMinimum(): Promise<AtsMinimum> {
    return { minAtsPercent: await this.repository.readAtsMinimum() }
  }

  async updateAtsMinimum(request: AtsMinimum): Promise<AtsMinimum> {
    await this.repository.writeAtsMinimum(request.minAtsPercent, this.clock.now())
    // Lowering the minimum releases every held Application whose resume now reaches it.
    await this.repository.requeueAtsHeld(this.clock.now())
    return this.atsMinimum()
  }

  async contact(): Promise<CandidateContact> {
    const row = await this.repository.readContact()
    return { fullName: row.full_name, lines: row.lines }
  }

  async updateContact(contact: CandidateContact): Promise<CandidateContact> {
    await this.repository.updateContact(contact.fullName, contact.lines, this.clock.now())
    return this.contact()
  }

  /** One Application's summary with its override (v1.24.0). */
  private async summary(row: Selectable<ApplicationTable>): Promise<ApplicationSummary> {
    return (await this.summaries([row], await this.graceEnd()))[0]!
  }

  /** Summaries with `override` from one posting-state read for all rows (no N+1). */
  private async summaries(rows: readonly Selectable<ApplicationTable>[], graceEnd: LocalDate): Promise<ApplicationSummary[]> {
    const now = this.clock.now()
    const { overrides, manual } = await this.tenant.run(async (tx, candidateId) => ({
      overrides: await overridesFor(tx, candidateId, rows, now),
      manual: await manualPostingIds(tx, rows.map((row) => row.job_posting_id)),
    }))
    return rows.map((row) => summaryOf(row, graceEnd, overrides.get(row.id) ?? null, manual))
  }

  /** The scope's Candidate's launch grace end (E4.6), read in their transaction. */
  private graceEnd(): Promise<LocalDate> {
    const now = this.clock.now()
    return this.tenant.run((tx, candidateId) => readGraceEnd(tx, candidateId, now))
  }

  private async contactHeader(): Promise<ContactHeader> {
    const row = await this.repository.readContact()
    return { name: row.full_name, lines: row.lines }
  }
}

/** v1.27.0: an Application made from a pasted description has the synthetic requisition `pasted:<posting id>`. */
export function isPastedRequisition(requisitionId: string): boolean {
  return requisitionId.startsWith("pasted:")
}

/**
 * `graceEnd`: the launch grace end from `readGraceEnd` (E4.6), so `expiresOn` matches the job's date.
 * `manualPostings` (v1.27.0): the posting ids whose apply mode is manual (`manualPostingIds`). Lists that only
 * hold automatic Applications (submissions, samples) leave it out; a pasted Application is manual either way.
 */
export function summaryOf(row: Selectable<ApplicationTable>, graceEnd: LocalDate, override: ApplicationOverride | null, manualPostings: ReadonlySet<string> = new Set()): ApplicationSummary {
  const pastedDescription = isPastedRequisition(row.requisition_id)
  // EPIC-0009 D5: the cause and terms are sent only while the Application is blocked, and a term the
  // contract would refuse is dropped and counted instead (TM-0009-04). An old row has none of these,
  // and a row whose details were deleted never sends them (TM-0009-07/16, AC 8.4).
  const blocked =
    row.state === "documents_blocked" && row.details_deleted_at === null
      ? storedTerms(row.blocked_claim_cause, row.blocked_claim_terms, row.blocked_claim_more_terms)
      : null
  return {
    id: row.id,
    jobPostingId: row.job_posting_id,
    company: row.company,
    roleTitle: row.role_title,
    requisitionId: row.requisition_id,
    applicationUrl: publicLink(row.application_url),
    pastedDescription,
    manualOnly: pastedDescription || manualPostings.has(row.job_posting_id),
    state: row.state,
    careerProfileVersion: row.career_profile_version,
    blockedDocument: row.blocked_document,
    blockedClaim: row.blocked_claim,
    ...(blocked !== null && row.blocked_claim_cause !== null ? { blockedClaimCause: row.blocked_claim_cause } : {}),
    ...(blocked !== null && blocked.terms !== null ? { blockedClaimTerms: blocked.terms, blockedClaimMoreTerms: blocked.moreTerms } : {}),
    failure: row.failure as ApplicationSummary["failure"],
    coverLetterStatus: row.cover_letter_status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    detailsDeletedAt: row.details_deleted_at?.toISOString() ?? null,
    expiresOn: expiresOn(row, graceEnd),
    // v1.27.0: never an override for a pasted Application (none is ever recorded).
    override: pastedDescription ? null : override,
  }
}

/** api-contract.md v1.24.0 refusal codes of `POST /v1/applications`, by create outcome. */
const CREATE_REFUSAL = {
  not_found: "not_found",
  hidden: "posting_hidden",
  not_eligible: "application_not_eligible",
  override_not_allowed: "override_not_allowed",
  override_acknowledgement_missing: "override_acknowledgement_missing",
  override_decision_changed: "override_decision_changed",
  override_application_state: "override_application_state",
} as const satisfies Record<Exclude<CreateOutcome["outcome"], "ok">, ApiErrorCode>

/** Event kinds that drop a queued Application (contract drop table; EPIC-0002 B1 "Drop event"). */
const DROP_EVENT_KINDS: ReadonlySet<string> = new Set(["queued_posting_dropped", "queued_posting_preferences_changed"])

/**
 * `ApplicationDetail.latestDrop` (design B3a): only with no submission state and
 * details present, when the latest queue-leaving event is a drop later than the
 * override's time. Events before v1.24.0 have detail null (not_submittable).
 * EPIC-0002 B1 (merge with main 0422b14): `queued_posting_preferences_changed`
 * is the same drop, caused by the Candidate's rules, with the same detail.
 */
export function latestDropOf(
  row: Readonly<{ submission_state: string | null; details_deleted_at: Date | null }>,
  override: ApplicationOverride | null,
  event: Readonly<{ kind: string; detail: string | null; created_at: Date }> | null
): LatestDrop | null {
  if (row.submission_state !== null || row.details_deleted_at !== null || event === null || !DROP_EVENT_KINDS.has(event.kind)) return null
  if (override !== null && event.created_at.getTime() <= Date.parse(override.createdAt)) return null
  const detail = queuedPostingDroppedDetailSchema.safeParse(event.detail)
  return { at: event.created_at.toISOString(), reason: latestDropReasonOf(detail.success ? detail.data : null) }
}

function documentView(row: Selectable<TailoredDocumentTable>, contact: ContactHeader | null): TailoredDocument {
  const content = row.content as unknown as DocumentContent
  return {
    kind: row.kind,
    careerProfileVersion: row.career_profile_version,
    createdAt: row.created_at.toISOString(),
    pdfUrl: documentDownloadPath(row.application_id, row.kind, "pdf"),
    docxUrl: documentDownloadPath(row.application_id, row.kind, "docx"),
    previewText: contact === null ? [] : plainTextOf(content, contact),
    ats: content.kind === "resume" && content.ats ? content.ats : null,
  }
}

function sortKinds<Row extends Selectable<TailoredDocumentTable>>(rows: readonly Row[]): Row[] {
  return [...rows].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "resume" ? -1 : 1))
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** ASCII-only download name, e.g. "Resume - Acme Payments - R-1042.pdf". */
export function downloadName(application: Pick<ApplicationTable, "company" | "requisition_id">, kind: DocumentKind, format: DocumentFormatValue): string {
  const label = kind === "resume" ? "Resume" : "Cover letter"
  const safe = (text: string) =>
    text
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/["\\/:*?<>|;]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60)
  // v1.27.0: a pasted Application's synthetic requisition key never appears in the name ("Resume - Paystack.pdf").
  const requisition = isPastedRequisition(application.requisition_id) ? "" : safe(application.requisition_id)
  const parts = [label, safe(application.company ?? ""), requisition].filter((part) => part !== "")
  return `${parts.join(" - ")}.${format}`
}
