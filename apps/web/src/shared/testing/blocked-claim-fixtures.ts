import type { ApplicationDetail } from "@eve/contracts"

import { readyApplication } from "./documents-api"

export const REDDIT_PARAGRAPH =
  "I work well in remote teams. I acted as the main frontend partner to product, backend and testing teams and cut implementation rework by 50%. At another company, I cut production crashes by 25%."
const ZETA = "abcdefghijklmnopqrstuvwxyz".split("").map((c) => `Zeta${c}word`)
export const ZETA_LINE = `I ${ZETA.join(" ")} daily.`

const reddit = { company: "Reddit", roleTitle: "Frontend Engineer, Ads", requisitionId: "R-9001", applicationUrl: "https://boards.greenhouse.io/reddit/jobs/9001" }
const blocked = (o: Partial<ApplicationDetail>): ApplicationDetail =>
  readyApplication({ ...reddit, state: "documents_blocked", careerProfileVersion: 1, documents: [], ...o })

/** E1: the owner's reproduction (Gherkin @ac-1.5). */
export const blockedReddit = (o: Partial<ApplicationDetail> = {}) =>
  blocked({ blockedDocument: "cover_letter", blockedClaim: REDDIT_PARAGRAPH, blockedClaimCause: "unsupported_terms", blockedClaimTerms: ["remote"], blockedClaimMoreTerms: 0, ...o })

/** E2: 26 located terms, 20 listed, 6 counted. */
export const blockedAtCap = (o: Partial<ApplicationDetail> = {}) =>
  blocked({ blockedDocument: "resume", blockedClaim: ZETA_LINE, blockedClaimCause: "unsupported_terms", blockedClaimTerms: ZETA.slice(0, 20), blockedClaimMoreTerms: 6, ...o })

/** E3: not_confirmed. The terms keys are absent, as the api sends them. */
export const blockedNotConfirmed = (o: Partial<ApplicationDetail> = {}) =>
  blocked({ blockedDocument: "cover_letter", blockedClaim: "I mentored 6 junior developers through the year.", blockedClaimCause: "not_confirmed", ...o })

/** E4: blocked before v1.30.0. None of the three keys. */
export const blockedBeforeRelease = (o: Partial<ApplicationDetail> = {}) =>
  blocked({ blockedDocument: "cover_letter", blockedClaim: REDDIT_PARAGRAPH, ...o })

/** E4 variant for @ac-6.4: the keys present as null (contract-valid; the api never sends it). */
export const blockedBeforeReleaseNulls = (o: Partial<ApplicationDetail> = {}) =>
  blockedBeforeRelease({ blockedClaimCause: null, blockedClaimTerms: null, blockedClaimMoreTerms: null, ...o })

/** E5: a cause this build does not know (newer api). */
export const blockedFutureCause = (o: Partial<ApplicationDetail> = {}) =>
  blocked({ blockedDocument: "cover_letter", blockedClaim: "I built Zorvex dashboards.", blockedClaimCause: "some_future_kind", blockedClaimTerms: ["Zorvex"], blockedClaimMoreTerms: 2, ...o })

/** L4 payload (@ac-1.11): a no-terms cause carrying terms. Valid by the contract; must render no list. */
export const blockedNoTermsKindWithTerms = (cause: "contact_detail" | "names_target" | "unknown_fact" | "not_confirmed") =>
  blocked({ blockedDocument: "cover_letter", blockedClaim: REDDIT_PARAGRAPH, blockedClaimCause: cause, blockedClaimTerms: ["led", "Zorvex"], blockedClaimMoreTerms: 3 })

/** OD-4: the only located term was over 120 units. Empty list, count 1. */
export const blockedOverLength = (o: Partial<ApplicationDetail> = {}) =>
  blocked({ blockedDocument: "resume", blockedClaim: 'I said "…" to the group.', blockedClaimCause: "unsupported_terms", blockedClaimTerms: [], blockedClaimMoreTerms: 1, ...o })
