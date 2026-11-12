import type { ResumeRefusalReason } from "@eve/contracts"

import { actionFailedMessage } from "@/shared/lib/action-failed"
import type { CareerProfile, ResumeDraftingFailure } from "./career-profile"
import { careerProfileCopy as copy } from "./copy"

/**
 * What the drop zone says after an upload refusal or a failed drafting
 * attempt (design-spec.r3 F1, "Resume upload refused" and "Drafting fails").
 * `retryLabel` is the drop zone button text (C-PROFILE-UP-1): "Choose another
 * file" when the same file would be refused again, "Try again" when the fault
 * was the server's or Anthropic's.
 */
export interface ResumeProblem {
  readonly message: string
  /** Muted line under the message (C-PROFILE-10a). */
  readonly detail: string | null
  readonly retryLabel: string
  /** A link under the message, such as "Go to the draft" (C-PROFILE-15). */
  readonly link: { readonly label: string; readonly to: string } | null
}

/** An upload the API refused, as the drop zone needs it: the contract code and reason. */
export type UploadRefusal =
  | { readonly kind: "wrong_file" }
  | { readonly kind: "unreadable"; readonly reason: ResumeRefusalReason | null }
  | { readonly kind: "storage_unavailable" }
  | { readonly kind: "not_approved" }
  | { readonly kind: "not_configured" }
  | { readonly kind: "drafting_in_progress" }
  | { readonly kind: "draft_exists" }
  | { readonly kind: "failed"; readonly action: string }

const problem = (message: string, retryLabel: string, extra: Partial<ResumeProblem> = {}): ResumeProblem => ({
  message,
  retryLabel,
  detail: null,
  link: null,
  ...extra,
})

const storageProblem = problem(copy.storageFailed, copy.tryAgain, { detail: copy.storageFailedDetail })

const REFUSAL_REASON_COPY: Record<ResumeRefusalReason, string> = {
  pages: copy.tooManyPages,
  characters: copy.tooManyCharacters,
  docx_limits: copy.docxLimits,
  parse_limits: copy.parseLimits,
  no_text: copy.noText,
}

/**
 * Copy for an upload refusal. `profile` is the latest Career Profile, read for
 * the filename in C-PROFILE-14 and the draft number in C-PROFILE-15.
 */
export function uploadRefusalProblem(refusal: UploadRefusal, profile: CareerProfile | undefined): ResumeProblem {
  switch (refusal.kind) {
    case "wrong_file":
      return problem(copy.wrongFile, copy.chooseAnotherFile)
    case "unreadable":
      // No reason (an older API): C-PROFILE-4's first sentence, which claims nothing about the cause.
      return problem(refusal.reason ? REFUSAL_REASON_COPY[refusal.reason] : copy.draftingFailed, copy.chooseAnotherFile)
    case "storage_unavailable":
      return storageProblem
    case "not_approved":
      return problem(copy.uploadDisabled, copy.chooseResume, {
        link: { label: copy.reviewAndApprove, to: "/privacy#ai-provider" },
      })
    case "not_configured":
      return problem(copy.notConfigured, copy.chooseResume)
    case "drafting_in_progress":
      return problem(copy.stillDrafting(profile?.drafting?.filename ?? null), copy.chooseResume)
    case "draft_exists": {
      const n = profile?.draft?.version
      // The page refetches the profile on a 409; until the draft number arrives, C-ERR-2.
      return n === undefined
        ? problem(actionFailedMessage("upload your resume"), copy.tryAgain)
        : problem(copy.draftExists(n), copy.chooseResume, { link: { label: copy.goToDraft, to: "/profile" } })
    }
    case "failed":
      return problem(actionFailedMessage(refusal.action), copy.tryAgain) // C-ERR-2
    default: {
      const exhaustive: never = refusal
      return exhaustive
    }
  }
}

/**
 * The resume whose drafting lost the race to a saved draft (`draft_exists`):
 * the draft view shows C-PROFILE-17 for it. Returns the filename ("" when the
 * API gave none), or null when there is no such attempt or no draft to show it
 * on. A new upload replaces `drafting`, so the notice goes with it.
 */
export function resumeNotUsedFilename(profile: CareerProfile): string | null {
  const { drafting, draft } = profile
  if (!draft || drafting?.status !== "failed" || drafting.failureReason !== "draft_exists") return null
  return drafting.filename
}

/**
 * The drafting failure the drop zone shows, or null. `draft_exists` is never a
 * drop-zone failure: while its draft exists the draft view explains it
 * (C-PROFILE-17), and once that draft is discarded nothing failed.
 */
export function dropZoneDraftingFailure(profile: CareerProfile): ResumeProblem | null {
  const { drafting } = profile
  if (drafting?.status !== "failed" || drafting.failureReason === "draft_exists") return null
  return draftingFailureProblem(drafting.failureReason)
}

/** Copy for a drafting attempt that failed after the 202, by `failureReason`. */
export function draftingFailureProblem(reason: ResumeDraftingFailure | null): ResumeProblem {
  switch (reason) {
    case "storage_error":
      return storageProblem
    case "provider_error":
    case "timed_out":
      return problem(copy.providerFailed, copy.tryAgain)
    case "not_configured":
      return problem(copy.notConfigured, copy.tryAgain)
    case "not_approved":
      return problem(copy.uploadDisabled, copy.chooseResume, {
        link: { label: copy.reviewAndApprove, to: "/privacy#ai-provider" },
      })
    default:
      // invalid_output, no_verified_facts, null and any later value (design-spec.r3 F1 table).
      // draft_exists never reaches here from the page: see dropZoneDraftingFailure.
      return problem(copy.noVerifiedFacts, copy.tryAgain)
  }
}
