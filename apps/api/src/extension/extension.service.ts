import { Inject, Injectable } from "@nestjs/common"
import type { ExtensionFillDocument, ExtensionFillRequest, ExtensionFillResponse, ExtensionFillUnanswered, ExtensionFillValue } from "@eve/contracts"

import { ApiException } from "../http/api-exception.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { type FormField, answerFor } from "../submission/answer-assignment.js"
import { type MatchedApplicationRow, SubmissionRepository } from "../submission/submission.repository.js"
import { FillRateLimiter } from "./fill-rate-limit.js"

/**
 * ADR 0016, slice 1: answer the extension's read of the Candidate's own form.
 *
 * Each field is classified by the automatic path's `answerFor`, with the same
 * `loadAnswerSources`, so a label is classified by backend code and a value
 * comes only from the Candidate's Approved Answers, salary answers and
 * settings. The plan never stops at the first hard block: every field is
 * visited, a value is returned with its control's kind, and a field that cannot
 * be answered (a hard block or a leftover) is listed with the reason the
 * Candidate needs to see. A document answer is named in `documents` by its ref
 * and kind, never in `values`: the extension downloads the prepared PDF from
 * its own route and no bytes cross this endpoint. This service reads and
 * writes nothing else: no Application state, no attempt, no event, no ledger
 * row. Values are returned to the extension and never logged.
 */
@Injectable()
export class ExtensionService {
  private readonly limiter = new FillRateLimiter()

  constructor(
    private readonly submissions: SubmissionRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async fill(request: ExtensionFillRequest, candidateId: string): Promise<ExtensionFillResponse> {
    // A fill reads the page and runs the answer rules; the Candidate's own session bounds it to 30 a minute.
    const retryAfter = this.limiter.check(candidateId, this.clock.now().getTime())
    if (retryAfter > 0) throw new ApiException("too_many_requests", undefined, undefined, retryAfter)
    const matched = await this.submissions.matchApplication(request.url)
    if (matched === null) return { application: null, values: [], documents: [], unanswered: [] }
    const application = toApplication(matched)
    const sources = await this.submissions.loadAnswerSources(application.id)
    const values: ExtensionFillValue[] = []
    const documents: ExtensionFillDocument[] = []
    const unanswered: ExtensionFillUnanswered[] = []
    for (const field of request.fields.map(toFormField)) {
      // Ashby's "Autofill from resume" uploader is not an application document. The reader skips it; a request
      // that still names it is skipped here too, so the resume is never mapped onto that control.
      if (field.kind === "file" && AUTOFILL_UPLOADER.test(field.label)) continue
      const outcome = answerFor(field, sources)
      if (outcome === "skip") continue
      if ("leftover" in outcome) {
        unanswered.push({ ref: field.ref, label: field.label, detail: outcome.leftover.detail })
        continue
      }
      if ("reason" in outcome) {
        unanswered.push({ ref: field.ref, label: field.label, detail: outcome.detail })
        continue
      }
      // The extension attaches the prepared document after the review; the file itself never travels here.
      if (outcome.kind === "document") {
        documents.push({ ref: outcome.ref, document: outcome.document })
        continue
      }
      values.push({ ref: outcome.ref, value: outcome.value, kind: field.kind })
    }
    return { application, values, documents, unanswered }
  }
}

/** The third uploader on Ashby's form feeds "Autofill from resume"; it never receives the resume. */
const AUTOFILL_UPLOADER = /autofill/i

/** The request's field in the shape answer assignment reads. Page text stays page text. */
function toFormField(field: ExtensionFillRequest["fields"][number]): FormField {
  return {
    ref: field.ref,
    label: field.label,
    kind: field.kind,
    required: field.required,
    ...(field.options === undefined ? {} : { options: field.options }),
    ...(field.combobox === undefined ? {} : { combobox: field.combobox }),
  }
}

/** The response's Application shape (contract `extensionFillApplicationSchema`). */
function toApplication(matched: MatchedApplicationRow): NonNullable<ExtensionFillResponse["application"]> {
  return { id: matched.id, company: matched.company, roleTitle: matched.role_title }
}
