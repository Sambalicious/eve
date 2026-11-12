import type { Migration } from "kysely/migration"

import * as dashboardAuth from "./0001-dashboard-auth.js"
import * as careerProfile from "./0002-career-profile.js"
import * as salaryAmountMax from "./0003-salary-amount-max.js"
import * as discovery from "./0004-discovery.js"
import * as applicationsDocuments from "./0005-applications-documents.js"
import * as submission from "./0006-submission.js"
import * as submissionReview from "./0007-submission-review.js"
import * as submissionRepair from "./0008-submission-repair.js"
import * as notificationSender from "./0009-notification-sender.js"
import * as costCeiling from "./0010-cost-ceiling.js"
import * as postingsPagingFilter from "./0011-postings-paging-filter.js"
import * as jobCriteria from "./0012-job-criteria.js"
import * as stackPosts from "./0013-stack-posts.js"
import * as accessRequest from "./0014-access-request.js"
import * as retention from "./0015-retention.js"
import { type MultiCandidateContext, multiCandidateMigration } from "./0016-multi-candidate.js"
import * as rowLevelSecurity from "./0017-row-level-security.js"
import * as ownerPreferences from "./0018-owner-preferences.js"
import * as candidatePosting from "./0019-candidate-posting.js"
import * as roleRelevance from "./0020-role-relevance.js"
import * as hiringPosts from "./0021-hiring-posts.js"
import * as candidateBinding from "./0022-candidate-binding.js"
import * as runtimeNoTemporary from "./0023-runtime-no-temporary.js"
import * as alertFeedCandidateVerification from "./0024-alert-feed-candidate-verification.js"
import * as applyAnyway from "./0025-apply-anyway.js"
import * as applyAnywayBounds from "./0026-apply-anyway-bounds.js"
import * as preferencesVersion from "./0027-preferences-version.js"
import * as atsSkills from "./0028-ats-skills.js"
import * as atsFit from "./0029-ats-fit.js"
import * as atsMinimum from "./0030-ats-minimum.js"
import * as pastedDescription from "./0031-pasted-description.js"
import * as stuckChecking from "./0032-stuck-checking.js"
import * as simplifyEve from "./0033-simplify-eve.js"
import * as forwardStatements from "./0034-forward-statements.js"
import * as manualApplyLane from "./0035-manual-apply-lane.js"
import * as retryFailedChecks from "./0036-retry-failed-checks.js"
import * as retryBackfill from "./0037-retry-backfill.js"
import * as leadPipeline from "./0038-lead-pipeline.js"
import * as blockedClaimCause from "./0039-blocked-claim-cause.js"
import * as outreachMessages from "./0040-outreach-messages.js"
import * as leadPolicyBinding from "./0041-lead-policy-binding.js"

/** Migrations that need nothing from the environment. */
const STATIC_MIGRATIONS: Record<string, Migration> = {
  "0001-dashboard-auth": dashboardAuth,
  "0002-career-profile": careerProfile,
  "0003-salary-amount-max": salaryAmountMax,
  "0004-discovery": discovery,
  "0005-applications-documents": applicationsDocuments,
  "0006-submission": submission,
  "0007-submission-review": submissionReview,
  "0008-submission-repair": submissionRepair,
  "0009-notification-sender": notificationSender,
  "0010-cost-ceiling": costCeiling,
  "0011-postings-paging-filter": postingsPagingFilter,
  "0012-job-criteria": jobCriteria,
  "0013-stack-posts": stackPosts,
  "0014-access-request": accessRequest,
  "0015-retention": retention,
}

/**
 * Every migration, in order. Listing them statically keeps the compiled
 * output free of filesystem lookups. Never rename or reorder an entry.
 * 0012 is EPIC-0004 (job criteria); 0013 is EPIC-0005 (stack posts); 0014 is
 * EPIC-0003 (access requests, merged first); 0015 is EPIC-0001 slice 9
 * (12-month expiry, merged first); EPIC-0002 A1 is 0016 to 0019; EPIC-0006 is
 * 0020 (merged first); EPIC-0007 Phase 3 is 0021 (merged first); EPIC-0002 A2
 * is 0022 (Candidate binding, repair wave 3) and 0023 (no temporary tables,
 * run a2c repair wave 2), renumbered in runs a2e and a2i. EPIC-0008
 * (per-Candidate Stack posts feed verification) is 0024, renumbered from 0022
 * when it merged after A2. Apply anyway (`application.candidate_override_at`)
 * is 0025, renumbered from 0015 when it merged after EPIC-0008. Apply anyway
 * bounds and consent (stored override decisions) is 0026.
 * EPIC-0002 B1 is 0027 (candidate_posting.preferences_version and the
 * Operator's value rewrite), renumbered from 0025 and then 0026 as apply anyway
 * and apply anyway bounds merged before it (D19).
 * EPIC-0010 (pasted job descriptions, Candidate-private postings) is 0031.
 * EPIC-0006 r4 stuck `checking` recovery (`candidate_posting.checking_since`) is 0032,
 * renumbered from 0026 when it merged after them (D19).
 * EPIC-0011 Simplify Eve (`candidate_view_setting`, `offer` Outcome) is 0033.
 * EPIC-0012 rule 4 (`job_posting.forward_statements`) is 0034.
 * EPIC-0009 blocked-claim cause and terms (`application.blocked_claim_cause`) is 0039.
 * EPIC-0014 Outreach messages (`outreach_message`) is 0040.
 * Lead policy binding (`lead_candidate` gains the 0022 binding) is 0041.
 * D19 (r5-addendum): no number is reserved, merge order decides, and a
 * migration that has run on production is never renamed.
 */
export function migrationsFor(context: MultiCandidateContext): Record<string, Migration> {
  return { ...STATIC_MIGRATIONS, "0016-multi-candidate": multiCandidateMigration(context), "0017-row-level-security": rowLevelSecurity, "0018-owner-preferences": ownerPreferences, "0019-candidate-posting": candidatePosting, "0020-role-relevance": roleRelevance, "0021-hiring-posts": hiringPosts, "0022-candidate-binding": candidateBinding, "0023-runtime-no-temporary": runtimeNoTemporary, "0024-alert-feed-candidate-verification": alertFeedCandidateVerification, "0025-apply-anyway": applyAnyway, "0026-apply-anyway-bounds": applyAnywayBounds, "0027-preferences-version": preferencesVersion, "0028-ats-skills": atsSkills, "0029-ats-fit": atsFit, "0030-ats-minimum": atsMinimum, "0031-pasted-description": pastedDescription, "0032-stuck-checking": stuckChecking, "0033-simplify-eve": simplifyEve, "0034-forward-statements": forwardStatements, "0035-manual-apply-lane": manualApplyLane, "0036-retry-failed-checks": retryFailedChecks, "0037-retry-backfill": retryBackfill, "0038-lead-pipeline": leadPipeline, "0039-blocked-claim-cause": blockedClaimCause, "0040-outreach-messages": outreachMessages, "0041-lead-policy-binding": leadPolicyBinding }
}

/** With no bound owner `sub`: enough for an empty database (a fresh install or a test template). */
export const migrations: Record<string, Migration> = migrationsFor({ operatorGoogleSub: undefined })
