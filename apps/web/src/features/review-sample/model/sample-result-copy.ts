import { blockedReasonLabel, evidenceLabel, overrideCopy, submissionCopy, type SampleResult, type Submission } from "@/entities/application"

const sc = submissionCopy.sample

/** What the page shows after an approval: C-SAMPLE-1 to 6, with C-SAMPLE-9 or 10 under it, and the link it names. */
export interface SampleOutcome {
  /** Only C-SAMPLE-13 has a title. */
  readonly title: string | null
  readonly line: string
  readonly countLine: string | null
  readonly link: { readonly label: string; readonly to: string } | null
  readonly tone: "success" | "warning" | "neutral"
}

interface Context {
  readonly company: string
  readonly requisitionId: string
  /** The violated rule's label for C-SAMPLE-3, when the posting is loaded. */
  readonly violatedRule: string | null
  readonly submission: Submission | undefined
  /** The posting detail, where C-SAMPLE-3a's "See Eligibility" goes. */
  readonly postingPath: string
  /** Automation is paused: C-SAMPLE-13's paused text. */
  readonly paused: boolean
}

export function sampleOutcome(result: SampleResult, ctx: Context): SampleOutcome {
  const n = result.countingSamples
  // Pending first: a repeat approval of an unfinished sample still shows "Submitting…" until the outcome arrives.
  if (result.result === "pending") return { title: null, line: sc.approving, countLine: null, link: null, tone: "neutral" }
  if (result.alreadyDone) return { title: null, line: sc.alreadyDone, countLine: null, link: null, tone: "neutral" }
  switch (result.result) {
    case "confirmed": {
      const evidence = ctx.submission?.evidence ? evidenceLabel[ctx.submission.evidence.kind] : evidenceLabel.confirmation_page
      return { title: null, line: sc.confirmed(ctx.company, evidence, n), countLine: null, link: null, tone: "success" }
    }
    case "uncertain":
      return {
        title: null,
        line: ctx.submission?.captchaAfterSubmit ? sc.uncertainCaptcha : sc.uncertain,
        countLine: sc.counts(n),
        link: { label: sc.resolveIt, to: "/uncertain" },
        tone: "warning",
      }
    case "excluded":
      // C-SAMPLE-3 names the rule; C-SAMPLE-3a when the posting doesn't say which rule is violated.
      return ctx.violatedRule
        ? { title: null, line: sc.excluded(ctx.violatedRule), countLine: sc.doesntCount(n), link: null, tone: "neutral" }
        : { title: null, line: sc.excludedUnnamed, countLine: sc.doesntCount(n), link: { label: sc.seeEligibility, to: ctx.postingPath }, tone: "neutral" }
    case "duplicate":
      return { title: null, line: sc.duplicate(ctx.requisitionId), countLine: sc.doesntCount(n), link: null, tone: "neutral" }
    case "blocked":
    case "held": {
      const reason = ctx.submission?.blocked?.reason ?? (result.result === "held" ? "same_company_review" : null)
      return {
        title: null,
        line: sc.blocked(reason ? blockedReasonLabel[reason] : submissionCopy.status.blocked),
        countLine: sc.doesntCount(n),
        link: { label: sc.openBlocked, to: "/blocked" },
        tone: "neutral",
      }
    }
    case "not_ranked":
      // v1.24.0 (AA-3.2): C-AA-36, then C-SAMPLE-10.
      return { title: null, line: overrideCopy.sampleNotRanked, countLine: sc.doesntCount(n), link: null, tone: "neutral" }
    case "not_allowed":
      // v1.24.0 (AA-3.2): the contract suggests the sample_not_allowed message (C-AA-37) as the line, then C-SAMPLE-10.
      return { title: null, line: overrideCopy.sampleNotAllowed, countLine: sc.doesntCount(n), link: null, tone: "neutral" }
    case "not_submitted":
      return {
        title: sc.notSent.title,
        line: ctx.paused ? sc.notSent.paused(ctx.company) : sc.notSent.text(ctx.company),
        countLine: null,
        link: null,
        tone: "warning",
      }
  }
}
