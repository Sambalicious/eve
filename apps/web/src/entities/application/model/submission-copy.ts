import { formatWatDate, formatWatDateTime } from "@/shared/lib/format-wat"
import type { BlockedReason, BlockedSubReason, EvidenceKind, GateRequirement } from "./submission"

/** "1 more sample Application" / "{n} more sample Applications" (C-GATE-3, C-CONFIRM-8s). */
const moreSamples = (n: number) => (n === 1 ? "1 more sample Application" : `${n} more sample Applications`)

/** "a", "a and b", "a, b and c" (C-GATE-3). */
function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("")
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

/** Reason labels (design-spec.r4.md, Blocked Applications table and status vocabulary). */
export const blockedReasonLabel: Record<BlockedReason, string> = {
  missing_approved_answer: "Missing Approved Answer",
  login: "Login",
  email_verification: "Email verification",
  captcha: "CAPTCHA",
  assessment: "Assessment",
  same_company_review: "Same-company review",
  declaration: "Declaration",
  personal_data_request: "Personal data request",
  automation_incomplete: "Automation couldn't complete the form",
  ats_below_minimum: "ATS match below your minimum",
}

/** C-BLOCK-10a to C-BLOCK-10d, fallback forms (the backend's detail line names the host or field when it knows them). */
export const subReasonFallback: Record<BlockedSubReason, string> = {
  budget: "It used up its time or effort limit for this form before every field was filled.",
  redirect: "The form sent the browser away from the employer's application site.",
  submit_attempt: "Something on the page tried to submit the form early. The assistant stopped it.",
  value_mismatch: "A field didn't hold the value the assistant set, so it didn't submit.",
}

/** Evidence card labels (r4). */
export const evidenceLabel: Record<EvidenceKind, string> = {
  confirmation_page: "Confirmation page",
  application_id: "Application ID",
  marked_confirmed: "Marked confirmed by you",
}

/** Copy from design-spec.r4.md (F2, F6, Activation Gate, Today's cap, Blocked and Uncertain catalogues). Exact strings. */
export const submissionCopy = {
  status: {
    confirmed: "Confirmed Submission",
    uncertain: "Uncertain Submission",
    blocked: "Blocked Application",
    manual: "Manual Application",
    notSubmitted: "Not submitted",
    queuedAgain: "Queued again",
    queuedForTomorrow: "Queued for tomorrow",
    submitting: "Submitting",
    declined: "Declined",
    held: "Held for your review",
    doesntCount: "Doesn't count",
    captchaAfterSubmit: "CAPTCHA after submit",
    sample: "Sample",
    /** C-QUEUE-1 badge. */
    queued: "Queued",
  },
  /** "How it was sent" (F9 column; plain text). */
  howSent: { automatic: "Automatic", sample: "Approved sample", manual: "Manual" },
  gate: {
    title: "Check first sends",
    navTitle: "Check first sends",
    progress: (n: number) => `${n} of 5 samples approved`,
    /** `existingApplications` is C-GATE-6's row label (owner decision 2026-10-30). */
    rows: { careerProfile: "Career Profile approved", existingApplications: "Jobs you've already applied to", samples: "5 samples approved" },
    /** Under the existing-applications row while it is not done: an empty list still counts. */
    existingHint: "Mark this either way. If you haven't applied anywhere yet, mark it complete.",
    /** The three-step explanation under the gate card, shown until the gate passes. */
    steps: {
      title: "How this works",
      items: [
        "Eve picks a few of your strongest matches and writes their documents. She does not send them.",
        "You read each one, then choose Approve and submit. That sends it to the employer, like a normal application.",
        "When five count, this step is done and you can turn on automatic submission. Eve then applies for you up to 5 times a day, and you can pause it.",
      ],
    },
    /** C-GATE-1. */
    before:
      "Automatic submission stays off until you approve your Career Profile, mark existing applications complete, and approve 5 sample Applications.",
    /** C-GATE-2. */
    passed: (at: string) => `Activation Gate passed on ${formatWatDateTime(at)}. You can turn on automatic submission.`,
    /** C-GATE-3. */
    refused: (missing: readonly GateRequirement[]) =>
      `Automatic submission can't be turned on yet. Still needed: ${joinList(
        missing.map((r) =>
          r.kind === "career_profile"
            ? "approve your Career Profile"
            : r.kind === "existing_applications"
              ? "mark existing applications complete"
              : `approve ${moreSamples(r.missing)}`
        )
      )}.`,
    /** C-GATE-4. */
    on: "The assistant submits up to 5 Applications per WAT day. Pause any time.",
    /** C-GATE-5. */
    help: "Only approved samples that reach a Confirmed or Uncertain Submission count. A sample that ends ineligible, duplicate or blocked doesn't count toward the 5.",
    turnOn: "Turn on automatic submission",
    isOn: "Automatic submission is on",
    isOff: "Automatic submission is off",
    paused: "Paused",
    /** C-CONFIRM-4. */
    confirmOn: {
      title: "Turn on automatic submission?",
      body: "The assistant will submit up to 5 Applications a day to eligible, strong-Match Job Postings without asking you first. You can pause it any time.",
      confirm: "Turn on",
    },
    tabs: { awaiting: "Awaiting review", approved: "Approved", rejected: "Rejected" },
    reviewSample: "Review sample",
    /** C-EMPTY-1. */
    empty: {
      title: "No samples yet",
      text: "The assistant prepares samples from eligible Job Postings once your Career Profile is approved and a Job Source is enabled or you paste a link.",
      action: "Go to Career Profile",
    },
    /** C-EMPTY-7, C-EMPTY-8. */
    emptyTab: {
      approved: {
        title: "No approved samples",
        text: "Samples you approve and submit show up here, with whether each one counts toward the 5.",
      },
      rejected: {
        title: "No rejected samples",
        text: "If you reject a sample, it shows up here with your reason. Nothing is sent for a rejected sample.",
      },
    },
    // OPEN[designer]: the spec has no copy for an explicit "Prepare samples" action, its pending label or its results. Used these.
    prepare: {
      action: "Prepare samples",
      pending: "Preparing…",
      created: (n: number) => (n === 1 ? "Prepared 1 sample for your review." : `Prepared ${n} samples for your review.`),
      noCandidates: "No more samples right now. The assistant needs eligible, strong-Match Job Postings with documents ready.",
      paused: "Automation is paused, so no samples were prepared. Resume automation, then try again.",
      careerProfile: "Approve your Career Profile first. Samples are prepared from it.",
      nothingNeeded: "No new samples are needed right now.",
    },
  },
  sample: {
    approve: "Approve and submit",
    approving: "Submitting…",
    /** After the page stops polling a sample the worker hasn't finished (v1.8.0). Not in design-spec.r4.md. */
    stillSubmitting: "Still submitting. Reload this page in a few minutes to see the result.",
    reject: "Reject",
    /** C-CONFIRM-3. */
    confirmApprove: {
      title: "Approve and submit this Application?",
      body: (company: string) =>
        `This sends the Application to ${company} now, with the documents and answers shown. It doesn't count toward the daily cap.`,
    },
    /**
     * g9 criteria note (g9-design-spec.md): `review-sample.criteria-note.title` and
     * `review-sample.criteria-note.body`. Byte-exact. The reason line is `skipLine()`
     * and the link is `jobPostingCopy.criteria.change` (entities/job-posting).
     */
    criteriaNote: {
      title: "This posting no longer meets your job criteria.",
      body: "You can still approve or reject this sample.",
    },
    rejectDialog: { title: "Reject this sample?", field: "Why are you rejecting this sample?", confirm: "Reject sample", pending: "Rejecting…" },
    /** C-SAMPLE-1 to C-SAMPLE-6 and C-SAMPLE-9, C-SAMPLE-10. */
    confirmed: (company: string, evidence: string, n: number) => `Submitted to ${company}. Confirmed by ${evidence}. ${n} of 5 samples approved.`,
    uncertain: "The form was submitted but no confirmation was seen. It's now an Uncertain Submission and won't be retried.",
    uncertainCaptcha:
      "The form was submitted, then a CAPTCHA appeared, so no confirmation was seen. It's now an Uncertain Submission and won't be retried.",
    resolveIt: "Resolve it",
    excluded: (rule: string) => `Not submitted. This Job Posting has a violated Eligibility rule: ${rule}.`,
    duplicate: (requisitionId: string) => `Not submitted. You already have an Application or existing application for requisition ${requisitionId}.`,
    blocked: (reason: string) => `Not submitted. It's now a Blocked Application: ${reason}.`,
    openBlocked: "Open Blocked Application",
    alreadyDone: "This sample was already approved. It was submitted once.",
    counts: (n: number) => `This counts toward the 5. ${n} of 5 samples approved.`,
    doesntCount: (n: number) => `This sample doesn't count toward the 5 because it wasn't submitted. ${n} of 5 samples approved.`,
    /** C-SAMPLE-13. */
    notSent: {
      title: "Not sent yet.",
      text: (company: string) =>
        `The assistant can't submit right now, so nothing went to ${company}. This sample is still waiting for your review and doesn't count toward the 5. Try again later.`,
      paused: (company: string) =>
        `Automation is paused, so nothing went to ${company}. This sample is still waiting for your review. Approve it again after you resume automation.`,
    },
    /** C-SAMPLE-3a. */
    excludedUnnamed: "Not submitted. This Job Posting breaks one of your Eligibility rules. Open its Eligibility panel to see which.",
    seeEligibility: "See Eligibility",
    /** C-SAMPLE-7. */
    rejectedToast: "Sample rejected. It wasn't submitted and doesn't count toward the 5.",
    /** C-SAMPLE-11. */
    markedNotSubmittedToast: (gatePassed: boolean, n: number) =>
      gatePassed
        ? "Marked as not submitted. It no longer counts as a sample, but the Activation Gate stays passed."
        : `Marked as not submitted. This sample no longer counts toward the 5. ${n} of 5 samples approved.`,
    /** C-SAMPLE-12. */
    markedNotSubmittedLine: (date: string) => `You marked this sample not submitted on ${formatWatDate(date)}, so it no longer counts toward the 5.`,
    rejectReasonLabel: "Reason:",
    /** C-SAMPLE-14 to C-SAMPLE-17 and the panel's column headers. */
    formAnswers: {
      title: "Form answers",
      help: (company: string) => `What the assistant will type into each field of ${company}'s form. It fills nothing that isn't listed here.`,
      columns: { question: "Question", answer: "Answer", source: "Source" },
      hidden: "Hidden. Sensitive answers aren't shown here.",
      hiddenSr: "Answer hidden because it's sensitive.",
      noApprovedAnswer: "No Approved Answer",
      empty: "This form asks nothing beyond your documents.",
      // OPEN[designer]: no copy for a form the worker hasn't read yet (`available: false`). Used this line.
      notRead: "The form hasn't been read yet; it's read at the next 09:00 run.",
    },
    /** C-SAMPLE-8. */
    missingAnswerWarning: (question: string) =>
      `This form has a required question with no Approved Answer: "${question}". Approving will block the Application instead of submitting it.`,
    jobPosting: "Job Posting",
  },
  /** C-VAL-SAMPLE-1, C-VAL-DECLINE-1, C-VAL-DECLINE-2. */
  validation: {
    sampleReasonEmpty: "Enter a reason for rejecting this sample.",
    declineReasonEmpty: "Enter a reason for declining this posting.",
    reasonTooLong: "Keep the reason under 500 characters.",
  },
  cap: {
    title: "Today's cap",
    of: (cap: number) => `of ${cap} automatic submissions today`,
    /** C-CAP-5, C-CAP-6, C-CAP-2, C-CAP-8, C-CAP-3. */
    help: "Counts Confirmed Submissions sent automatically today (WAT). Manual Applications, approved samples and unresolved Uncertain Submissions don't count.",
    reached: "Today's cap is reached. Automatic submission resumes at 00:00 WAT.",
    over: (n: number) => `${n} of 5. A late confirmation counted toward the day it was submitted.`,
    queued: (q: number) => `${q} Job Posting(s) queued for tomorrow.`,
    seeThem: "See them",
    queuedForTomorrowLine:
      "Today's 5 automatic submissions are used. This goes into tomorrow's queue and is ranked again with tomorrow's new Job Postings.",
  },
  needsYou: {
    title: "Needs you",
    samples: "Samples awaiting review",
    blocked: "Blocked Applications",
    uncertain: "Uncertain Submissions",
    none: "None",
  },
  automation: { title: "Automation" },
  blocked: {
    title: "Blocked",
    group: (label: string, n: number) => `${label} (${n})`,
    blockedAt: (at: string) => `Blocked ${formatWatDateTime(at)}`,
    /** C-BLOCK-10. */
    automationIncomplete:
      "The assistant stopped before the submit button, so the employer received nothing. Apply yourself with the prepared documents, then mark it completed manually. The assistant won't try this form again.",
    /** C-BLOCK-9. */
    answerSaved: "Answer saved. This Application goes back to automatic submission and counts toward the cap on the day it's sent.",
    /** C-BLOCK-14. */
    notRequeueable:
      "This Application can't go back to automatic submission. The assistant couldn't complete this form, so it won't try again. Apply yourself with the prepared documents, then mark it completed manually.",
    addAnswer: "Add Approved Answer",
    openEmployerForm: "Open employer form",
    downloadResume: "Download resume",
    downloadCoverLetter: "Download cover letter",
    markManual: "Mark completed manually",
    approveSubmission: "Approve submission",
    declinePosting: "Decline posting",
    /** C-CONFIRM-5 and its toast. */
    confirmManual: {
      title: "Mark as completed manually?",
      body: "Use this after you've applied on the employer site yourself. It becomes a Manual Application and doesn't count toward the daily cap.",
      confirm: "Mark completed",
      pending: "Marking…",
    },
    manualToast: "Recorded as a Manual Application.",
    /** C-CONFIRM-6. */
    confirmSameCompany: {
      title: (company: string) => `Submit to ${company} again?`,
      body: "You already have an active Application there. This one will be submitted under the normal rules and counts toward the daily cap.",
      pending: "Approving…",
    },
    /** C-CONFIRM-19. */
    confirmDecline: {
      title: (role: string, company: string) => `Decline ${role} at ${company}?`,
      body: "It won't be submitted, and it stays declined if the assistant finds it again. You can't approve it later. Your reason is saved with it.",
      field: "Why are you declining it?",
      help: "Saved with the posting so you can see it later.",
      pending: "Declining…",
    },
    /** C-BLOCK-11, C-BLOCK-12a/b/d. */
    declinedToast: (role: string, company: string) => `Declined ${role} at ${company}. It won't be submitted.`,
    /** C-BLOCK-12a and C-BLOCK-12d; the dateless form only when the backend has no decline date (declined before v1.7.0). */
    alreadyDeclined: (date: string | null) =>
      date ? `This posting was already declined on ${formatWatDate(date)}. The first reason is kept.` : "This posting was already declined. The first reason is kept.",
    alreadyApproved: "This posting was already approved for submission, so it can't be declined now.",
    approveRefusedDeclined: (date: string | null) =>
      date ? `You declined this posting on ${formatWatDate(date)}, so it can't be approved.` : "You declined this posting, so it can't be approved.",
    /** C-EMPTY-3. */
    empty: {
      title: "No Blocked Applications",
      text: "When a form needs an answer, sign-in, CAPTCHA or assessment from you, or the assistant can't finish it, it shows up here and you get an email.",
    },
  },
  uncertain: {
    title: "Unsure sends",
    /** C-UNC-1, C-UNC-5, C-UNC-8. */
    noEvidence: (at: string) =>
      `The form was submitted on ${formatWatDateTime(at)}, but no confirmation page or application ID was seen. The assistant won't retry it. Check your email or the employer site, then mark it.`,
    captcha: (at: string) =>
      `The form was submitted on ${formatWatDateTime(at)}, then a CAPTCHA appeared. The assistant doesn't solve CAPTCHAs, so it couldn't see a confirmation page. It won't retry. Check your email or the employer site, then mark it.`,
    freshAttempt: (at: string) =>
      `This was the one more attempt after you marked it not submitted. The form was submitted on ${formatWatDateTime(at)}, but again no confirmation was seen. The assistant won't retry it. Check your email or the employer site, then mark it.`,
    submittedAt: (at: string) => `Submitted ${formatWatDateTime(at)}`,
    openEmployerPage: "Open employer page",
    markConfirmed: "Mark confirmed",
    markNotSubmitted: "Mark not submitted",
    /** C-CONFIRM-7. */
    confirmConfirmed: {
      title: "Mark as confirmed?",
      body: (day: string) =>
        `Do this only if you've seen proof the employer received it. It will count toward ${formatWatDate(day)}, even if that day goes over 5.`,
      pending: "Marking…",
    },
    /** C-CONFIRM-8, C-CONFIRM-8a, C-CONFIRM-8s. */
    confirmNotSubmitted: {
      title: "Mark as not submitted?",
      first:
        "Do this only if you're sure the employer didn't receive it. It goes back to the automatic queue for one more attempt, which still follows the daily cap, duplicate, same-company, closed-posting and pause rules. If that attempt also gets no confirmation, it becomes an Uncertain Submission again and won't be retried.",
      fresh: "This was already the one more attempt. If you mark it not submitted, the assistant won't try it again. You can still apply on the employer site yourself.",
      sampleTitle: "Mark this sample as not submitted?",
      sampleBefore: (company: string, n: number) =>
        `Do this only if you're sure ${company} didn't receive it. It will stop counting toward the 5, so you'll need ${moreSamples(n)} to pass the Activation Gate.`,
      sampleAfter: (company: string) => `Do this only if you're sure ${company} didn't receive it. It stops counting as a sample. The Activation Gate stays passed.`,
      pending: "Marking…",
    },
    /** C-UNC-2, C-UNC-3, C-UNC-3a, C-UNC-4. */
    confirmedToast: (day: string) => `Marked as a Confirmed Submission. It counts toward ${formatWatDate(day)}.`,
    notSubmittedToast: "Marked as not submitted. It doesn't count toward the cap. It's back in the queue for one more attempt.",
    notSubmittedFinalToast: "Marked as not submitted. The assistant won't try it again.",
    alreadyResolved: (status: string) => `This was already resolved: ${status}.`,
    /** C-UNC-4a. */
    alreadyResolvedUnknown: "This was already resolved somewhere else. The page now shows its current status.",
    /** C-EMPTY-4. */
    empty: { title: "No Uncertain Submissions", text: "If a form is submitted without confirmation, it waits here for you to check." },
  },
  detail: {
    evidenceTitle: "Evidence",
    howSentLabel: "How it was sent",
    /** F9 column "submitted (WAT)", as a header label. */
    submittedLabel: "Submitted",
    observed: (at: string) => `Observed ${formatWatDateTime(at)}`,
    submittedOn: (at: string) => `Submitted ${formatWatDateTime(at)}`,
    /** C-UNC-6, C-UNC-9, C-UNC-10, C-BLOCK-13. */
    /** C-QUEUE-1 line. */
    queued: "Waiting in today's automatic queue. The assistant sends it under the daily cap, duplicate, same-company, closed-posting and pause rules.",
    queuedAgain: (date: string) =>
      `You marked this not submitted on ${formatWatDate(date)}. It's back in the automatic queue for one more attempt, under the usual cap, duplicate, same-company, closed-posting and pause rules.`,
    notSubmittedFinal: "Not submitted. The assistant won't try this one again. You can still apply on the employer site yourself.",
    sampleNotSubmitted: (date: string) =>
      `You marked this sample not submitted on ${formatWatDate(date)}. It doesn't count toward the 5, and the assistant won't send it again on its own. You can still apply on the employer site yourself.`,
    declined: (date: string) => `You declined this at same-company review on ${formatWatDate(date)}.`,
    yourReason: "Your reason:",
    openBlocked: "Open Blocked Applications",
    openUncertain: "Open Uncertain Submissions",
  },
} as const

/** C-SAMPLE-1 to C-SAMPLE-5 text for a result, without the count line. */
