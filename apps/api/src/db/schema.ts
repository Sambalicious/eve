import type { ColumnType, Generated } from "kysely"

export interface DashboardSessionTable {
  /** SHA-256 (hex) of the session ID held in the cookie. The raw ID is never stored. */
  id_hash: string
  csrf_token: string
  google_sub: string
  created_at: Generated<Date>
  last_active_at: Date
  /** EPIC-0002 A1: the signed-in Candidate's row; every session names it (no default). */
  candidate_id: string
}

export interface SignInAttemptTable {
  /** SHA-256 (hex) of the attempt ID held in the short-lived attempt cookie. */
  id_hash: string
  state: string
  nonce: string
  code_verifier: string
  return_path: string
  created_at: Date
}

export interface AiProviderApprovalTable {
  provider: "anthropic"
  approved_at: Date
  /** `date` column; pg returns it as a Date at UTC midnight. */
  terms_checked_on: Date | string
  training_line: string
  retention_line: string
  whats_sent_line: string
}

export type AiCallStatus = "started" | "succeeded" | "invalid_output" | "provider_error" | "timed_out"

export interface AiCallTable {
  /** EPIC-0002 A1: null only for shared work (posting extraction after slice B). */
  candidate_id: string | null
  id: string
  purpose: string
  provider: string
  model: string
  status: AiCallStatus
  input_tokens: number | null
  output_tokens: number | null
  cache_read_input_tokens: number | null
  cache_creation_input_tokens: number | null
  resume_upload_id: string | null
  job_posting_id: Generated<string | null>
  application_id: Generated<string | null>
  started_at: Date
  finished_at: Date | null
}

export type ResumeUploadStatus = "drafting" | "drafted" | "failed"

export interface ResumeUploadTable {
  /** EPIC-0002 A1: the owning Candidate (0016), named on every write; RLS keys on it (0017). */
  candidate_id: string
  id: string
  original_filename: string
  media_type: string
  byte_size: number
  sha256: string
  /** Server-generated file name inside the Candidate's `resumes` area (A2 CandidateFiles); never derived from the upload. */
  storage_name: string
  status: ResumeUploadStatus
  failure_reason: string | null
  started_at: Date
  finished_at: Date | null
}

export type CareerProfileVersionStatus = "draft" | "approved" | "replaced"

/** Stored shape of a section; mirrors the contract's CareerProfileSection. */
export type StoredSection = {
  id: string
  kind: "experience" | "education" | "skills" | "summary" | "other"
  title: string
  organization: string | null
  period: string | null
  sourceQuote: string | null
  facts: { id: string; text: string; sourceQuote: string | null }[]
}

export interface CareerProfileVersionTable {
  /** EPIC-0002 A1: the owning Candidate (0016), named on every write; RLS keys on it (0017). */
  candidate_id: string
  version: number
  status: CareerProfileVersionStatus
  source: "resume" | "edit"
  resume_upload_id: string | null
  sections: ColumnType<StoredSection[], string, string>
  rejected_fact_count: Generated<number>
  created_at: Date
  approved_at: Date | null
}

export interface ApprovedAnswerTable {
  /** EPIC-0002 A1: the owning Candidate (0016), named on every write; RLS keys on it (0017). */
  candidate_id: string
  id: string
  answer_group: "standard" | "sensitive" | "custom"
  topic: string | null
  skill: string | null
  question: string | null
  answer_key: string
  value: string
  created_at: Date
  updated_at: Date
}

export interface GrossSalaryAnswerTable {
  /** EPIC-0002 A1: the owning Candidate (0016), named on every write; RLS keys on it (0017). */
  candidate_id: string
  kind: "gross_salary_policy" | "current_salary"
  /** numeric(12,2): pg returns a string. */
  amount: ColumnType<string, string, string>
  currency: string
  period: "year" | "month"
  updated_at: Date
}

export interface PreferredNetPayTable {
  /** EPIC-0002 A1: the owning Candidate (0016), named on every write; RLS keys on it (0017). */
  candidate_id: string
  amount: ColumnType<string, string, string>
  currency: string
  updated_at: Date
}

export interface CandidateSettingTable {
  /** EPIC-0002 A1: the owning Candidate (0016), named on every write; RLS keys on it (0017). */
  candidate_id: string
  work_authorization: string
  /** ATS minimum for automatic submission, 0 to 100 (0030); 0 turns the gate off. */
  min_ats_percent: Generated<number>
  updated_at: Generated<Date>
}

export interface ControlStateTable {
  singleton: Generated<boolean>
  global_paused: Generated<boolean>
  cost_paused: Generated<boolean>
  // Migration 0010 (slice 7).
  cost_paused_at: Generated<Date | null>
  /** `date` column (first of the WAT month), read as text. */
  cost_paused_month: ColumnType<string | null, string | null | undefined, string | null>
  cost_pause_action: Generated<string | null>
  cost_pause_estimate_micros: ColumnType<string | null, string | number | bigint | null | undefined, string | number | bigint | null>
  cost_pause_cleared_at: Generated<Date | null>
  global_paused_at: Generated<Date | null>
}

export interface EvaluationSettingTable {
  singleton: Generated<boolean>
  // `match_threshold` stays in the database for rollback safety but is left out of this type on purpose
  // (EPIC-0004 AC 7.2): only migration 0012 reads it, in raw SQL. The minimum core Match is `job_criteria`.
  hours_cutoff: Generated<string>
  hours_time_zone: Generated<string>
  updated_at: Generated<Date>
}

/** Migration 0012 (EPIC-0004): the Candidate's Job criteria, one row per Candidate (0016). */
export interface JobCriteriaTable {
  /** EPIC-0002 A1: the owning Candidate (0016), named on every write; RLS keys on it (0017). */
  candidate_id: string
  min_core_match_percent: number
  frameworks: ColumnType<string[], string[] | undefined, string[]>
  technologies: ColumnType<string[], string[] | undefined, string[]>
  version: Generated<number>
  updated_at: Generated<Date>
  /** Migration 0020 (EPIC-0006): target role families, catalog order; defaults to the AC-1.6 nine. */
  target_role_families: ColumnType<string[], string[] | undefined, string[]>
  /** Migration 0020 (EPIC-0006 AC-2.1). */
  seniority_floor: ColumnType<"all_levels" | "hide_entry_level", "all_levels" | "hide_entry_level" | undefined, "all_levels" | "hide_entry_level">
}

/**
 * Migration 0024 (EPIC-0008, AR-1; 0022 in its contract, renumbered at merge): a Candidate's own Stack posts permitted-use record; one row at most.
 * Same columns as `hiring_feed_verification`. The legacy shared 0013 record table stays in the database
 * for rollback (AR-5) but is deliberately not in `Database`, so typed code cannot name it.
 */
export interface AlertFeedCandidateVerificationTable {
  candidate_id: string
  /** `date`, read as text. */
  verified_on: ColumnType<string, string, string>
  verification_basis: string
  updated_at: Date
}

export type AlertFeedFailureCode = "not_reachable" | "unexpected_response" | "redirected" | "not_a_feed" | "too_large" | "timed_out"

/** Migration 0013: a registered Google Alerts feed. `url` is never returned after registration (D-E5-5). */
export interface AlertFeedTable {
  /** EPIC-0002 A1: the owning Candidate (0016), named on every write; RLS keys on it (0017). */
  candidate_id: string
  id: string
  url: string
  label: string | null
  created_at: Date
  last_read_at: Date | null
  last_failure_reason: AlertFeedFailureCode | null
  last_failed_at: Date | null
}

/** Migration 0013: one stored LinkedIn post or article (AC 5.4). */
export interface StackPostTable {
  /** EPIC-0002 A1: the owning Candidate (0016), named on every write; RLS keys on it (0017). */
  candidate_id: string
  id: string
  canonical_url: string
  kind: "post" | "article"
  title: ColumnType<string, string | undefined, string>
  snippet: ColumnType<string, string | undefined, string>
  published_at: Date | null
  matched_technologies: ColumnType<string[], string[] | undefined, string[]>
  source_feed_id: string | null
  first_seen_at: Date
}

/** Migration 0013: one scheduled read run (AC 6.6). */
export interface StackPostRunTable {
  /** EPIC-0002 A1: the owning Candidate (0016), named on every write; RLS keys on it (0017). */
  candidate_id: string
  id: string
  started_at: Date
  finished_at: Date | null
  outcome: "running" | "completed" | "skipped_global_pause" | "skipped_unverified"
  feeds_read: Generated<number>
  feeds_failed: Generated<number>
  posts_stored: Generated<number>
  posts_deleted: Generated<number>
}

/** Migration 0021 (EPIC-0007 Phase 3): a Candidate's Hiring Alert feed. Same columns as `alert_feed`. */
export type HiringAlertFeedTable = AlertFeedTable

/** Migration 0021: one Hiring post. Same columns as `stack_post`; `source_feed_id` names a `hiring_alert_feed`. */
export type HiringPostTable = StackPostTable

/** Migration 0021: one scheduled Hiring read run for one Candidate. */
export type HiringPostRunTable = StackPostRunTable

/** Migration 0021 (D14): a Candidate's own permitted-use record for Hiring Alert feeds; one row at most. */
export interface HiringFeedVerificationTable {
  candidate_id: string
  /** `date`, read as text. */
  verified_on: ColumnType<string, string, string>
  verification_basis: string
  updated_at: Date
}

/** A verified technology on `job_posting.technologies` (AC 4.4). */
export type StoredTechnology = { name: string; quote: string }

export interface EmployerListStateTable {
  singleton: Generated<boolean>
  approved_at: Date | null
}

export interface EmployerBoardTable {
  id: string
  position: number
  company: string
  application_system: "greenhouse" | "lever" | "ashby"
  board_token: string
  flag: "crypto" | null
  note: string | null
  last_read_at: Date | null
}

export type RemoteBoardKey = "himalayas" | "remoteok" | "remotive" | "weworkremotely"

export interface RemoteBoardTable {
  key: RemoteBoardKey
  name: string
  position: number
  /** `date` column. */
  verified_on: Date | string | null
  verification_basis: string | null
  enabled: Generated<boolean>
  available: boolean
  unavailable_reason: string | null
  attribution_name: string
  attribution_url: string
  last_read_at: Date | null
}

/** Migration 0020 (EPIC-0006) adds `not_checked` on `candidate_posting`. */
export type JobPostingStatus = "checking" | "waiting_to_be_checked" | "not_checked" | "ranked" | "excluded" | "skipped" | "evaluation_failed"

export interface JobPostingTable {
  id: string
  application_url: string
  requisition_id: string
  apply_url: string
  application_system: string
  apply_mode: "automatic" | "manual"
  /** 0031 (EPIC-0010): `pasted_description` is a Candidate-private row (owner set, always `manual`). */
  origin: JobPostingOrigin
  employer_board_id: string | null
  remote_board_key: RemoteBoardKey | null
  attribution_name: string | null
  attribution_url: string | null
  title: string | null
  company: string | null
  posting_text: Generated<string>
  structured: ColumnType<Record<string, unknown>, string | undefined, string>
  /*
   * EPIC-0002 A1 item 6: status, skip_reason, skip_detail, evaluation_failure
   * and evaluated_at moved to `candidate_posting` (migration 0019). The columns
   * stay in the database, unwritten, for one release; they are left out of this
   * type so no code can read or write them.
   */
  role_family: string | null
  /** When the posting was first stored; each Candidate's own time is `candidate_posting.discovered_at`. */
  discovered_at: Date
  /** Migration 0019 (r4): the slice 8 pre-filter's skip, a posting fact decided once at first store. */
  prefilter_skip: ColumnType<"not_software_role" | null, "not_software_role" | null | undefined, "not_software_role" | null>
  /** Migration 0012: null = no technology data ("not checked"); [] = checked, none found. */
  technologies: ColumnType<StoredTechnology[] | null, string | null | undefined, string | null>
  /** ATS key skills (0028), verified like `technologies`. Null until evaluated again. */
  ats_skills: ColumnType<StoredTechnology[] | null, string | null | undefined, string | null>
  /** Slice 8: `foldForKeywords(title)`, written with the title; null when untitled. The title keyword matches against it. */
  title_folded: Generated<string | null>
  /** Migration 0020 (EPIC-0006 AC-5.1): the shared posted date; null = undated. Never overwritten once set (AC-5.6). */
  posted_at: ColumnType<Date | null, Date | null | undefined, Date | null>
  posted_date_kind: ColumnType<"published" | "updated" | null, "published" | "updated" | null | undefined, "published" | "updated" | null>
  /** Migration 0020 (AC-2.2): from the title; null when untitled. */
  seniority_marker: ColumnType<"entry" | "mid_plus" | "none" | null, "entry" | "mid_plus" | "none" | null | undefined, "entry" | "mid_plus" | "none" | null>
  /** 0031 (EPIC-0010, ADR 0013): the one Candidate who may see this row; null for a shared posting. Forced RLS keys on it. */
  owner_candidate_id: ColumnType<string | null, string | null | undefined, string | null>
  /** 0031: hex sha256 of a description-only paste (title, company, text); null otherwise. */
  paste_fingerprint: ColumnType<string | null, string | null | undefined, string | null>
  /** EPIC-0012 rule 4 (0034): up to 3 verified forward-looking quotes; null when none and for pasted descriptions. */
  forward_statements: ColumnType<string[] | null, string | null | undefined, string | null>
}

/** Where a posting came from (0004, 0019; 0031 adds `pasted_description`). */
export type JobPostingOrigin = "employer_board" | "remote_board" | "pasted_link" | "pasted_description"

/**
 * EPIC-0002 A1 item 6 (migration 0019): one Candidate's state for a shared
 * `job_posting`. RLS keys on `candidate_id`. Before the split these columns
 * lived on `job_posting`, where a second Candidate's write replaced the first's.
 */
export interface CandidatePostingTable {
  candidate_id: string
  job_posting_id: string
  /** How this Candidate got the posting; `job_posting.origin` stays "how it was first found". */
  origin: JobPostingOrigin
  status: JobPostingStatus
  skip_reason: string | null
  skip_detail: string | null
  evaluation_failure: string | null
  discovered_at: Date
  evaluated_at: Date | null
  /** Migration 0032 (EPIC-0006 AC-7.12): the last move into `checking`; read only with `status = 'checking'`, never cleared. */
  checking_since: ColumnType<Date, Date | undefined, Date>
  /** EPIC-0002 B1 (migration 0027): the Job Preferences version the stored decision used; 0 for decisions before B1. */
  preferences_version: Generated<number>
  /** Migration 0036 (v1.28.1): failed evaluations, so the worker retries a transient failure exactly once. */
  evaluation_attempts: Generated<number>
}

export interface EligibilityResultTable {
  /** EPIC-0002 A1: the owning Candidate (0016), named on every write; RLS keys on it (0017). */
  candidate_id: string
  job_posting_id: string
  arrangement: "remote" | "relocation" | "onsite"
  relocation_country: string | null
  employment_type: "direct" | "employer_of_record" | "contract" | null
  rules: ColumnType<StoredRule[], string, string>
  eligible: boolean
  normalized_monthly_max_usd: ColumnType<string | null, string | null, string | null>
  fx_rate_date: Date | string | null
  evaluated_at: Date
}

export type StoredRule = { rule: string; result: string; quote: string | null }
export type StoredMatchItem = { group: "core" | "mandatory" | "nice_to_have"; text: string; factId: string | null }

export interface MatchEvidenceTable {
  /** EPIC-0002 A1: the owning Candidate (0016), named on every write; RLS keys on it (0017). */
  candidate_id: string
  job_posting_id: string
  career_profile_version: number
  verdict: "strong" | "weak"
  weak_reason: string | null
  covered_count: number
  total_count: number
  threshold: ColumnType<string, string, string>
  items: ColumnType<StoredMatchItem[], string, string>
  evaluated_at: Date
  /** Migration 0012 (AC 5.7): the criteria version and canonical technology entries the decision used. */
  criteria_version: number
  criteria_technologies: ColumnType<string[], string[] | undefined, string[]>
  /** ATS fit 0 to 100 (0029); null for evidence written before it. */
  ats_fit: ColumnType<number | null, number | null | undefined, number | null>
}

export interface CandidateContactTable {
  /** EPIC-0002 A1: the owning Candidate (0016), named on every write; RLS keys on it (0017). */
  candidate_id: string
  full_name: Generated<string>
  lines: ColumnType<string[], string | undefined, string>
  updated_at: Generated<Date>
}

export type ApplicationState = "prepared" | "generating" | "documents_ready" | "documents_blocked" | "documents_failed"

export interface ApplicationTable {
  /** EPIC-0002 A1: the owning Candidate (0016), named on every write; RLS keys on it (0017). */
  candidate_id: string
  id: string
  job_posting_id: string
  application_url: string
  requisition_id: string
  company: string | null
  role_title: string | null
  state: ApplicationState
  career_profile_version: number | null
  blocked_document: "resume" | "cover_letter" | null
  blocked_claim: string | null
  // Migration 0039 (EPIC-0009): why the paragraph was blocked, and the terms as written.
  blocked_claim_cause: Generated<string | null>
  blocked_claim_terms: Generated<string[] | null>
  blocked_claim_more_terms: Generated<number | null>
  failure: string | null
  created_at: Date
  updated_at: Date
  // Slice 5 (migration 0006): submission.
  submission_state: Generated<SubmissionState | null>
  submission_kind: Generated<"automatic" | "sample" | null>
  attempt_id: Generated<string | null>
  attempt_number: Generated<number>
  submit_clicked_at: Generated<Date | null>
  /** `date` column, read as text. */
  submitted_local_day: Generated<string | null>
  confirmed_at: Generated<Date | null>
  evidence_kind: Generated<EvidenceKind | null>
  evidence_text: Generated<string | null>
  captcha_after_submit: Generated<boolean>
  blocked_reason: Generated<BlockedReason | null>
  blocked_sub_reason: Generated<BlockedSubReason | null>
  blocked_detail: Generated<string | null>
  blocked_at: Generated<Date | null>
  cover_letter_status: Generated<"not_submitted" | "uploaded" | "no_field">
  sample_state: Generated<"awaiting_review" | "approved" | "rejected" | null>
  sample_reject_reason: Generated<string | null>
  sample_counts: Generated<boolean>
  declined_reason: Generated<string | null>
  manual_completed_at: Generated<Date | null>
  queued_for_local_day: Generated<string | null>
  // Migration 0007.
  declined_at: Generated<Date | null>
  marked_not_submitted_at: Generated<Date | null>
  blocked_question: Generated<string | null>
  // Migration 0008 (CR5-04).
  same_company_approved_at: Generated<Date | null>
  // Migration 0010 (slice 7, AC 10.3).
  details_deleted_at: Generated<Date | null>
  final_status: Generated<string | null>
  // Migration 0016: the zone `submitted_local_day` was computed in, stored once.
  submitted_local_day_zone: Generated<string | null>
  // Migration 0015-retention (automatic expiry, E6.1). Null on rows an older api deleted: read as "candidate".
  details_deleted_by: Generated<DeletedBy | null>
  // Migration 0025: created from a skipped or excluded posting ("apply anyway").
  candidate_override_at: Generated<Date | null>
  // Migration 0026: the override's time and the decision the Candidate saw (all decision fields null for a legacy override).
  override_created_at: Generated<Date | null>
  override_status: Generated<"skipped" | "excluded" | null>
  override_skip_reason: Generated<string | null>
  override_skip_detail: Generated<string | null>
  override_violated_rules: ColumnType<string[] | null, string[] | null | undefined, string[] | null>
}

/** Who deleted an Application's detailed records (E6.1). */
export type DeletedBy = "candidate" | "expiry"

export type RetentionRunOutcome = "running" | "completed" | "skipped_global_paused" | "skipped_launch_grace" | "failed"

/** One row per `retention.daily` run (E6.2): counts only, no career data. */
export interface RetentionRunTable {
  /** EPIC-0002 A1 (merge 11): the Candidate whose records this run expired (0016); RLS keys on it (0017). */
  candidate_id: string
  id: string
  /** `date` column. */
  wat_date: ColumnType<Date | string, string, string>
  started_at: Date
  finished_at: Date | null
  outcome: RetentionRunOutcome
  due_count: Generated<number>
  deleted_count: Generated<number>
  skipped_in_flight: Generated<number>
  skipped_pending_decision: Generated<number>
  skipped_locked: Generated<number>
  failed_count: Generated<number>
  files_released: Generated<number>
}

export interface ApplicationFormReadTable {
  /** EPIC-0002 A1: the owning Candidate (0016), named on every write; RLS keys on it (0017). */
  candidate_id: string
  application_id: string
  host: string
  controls: ColumnType<StoredFormControl[], string, string>
  read_at: Date
}

export type StoredFormControl = {
  ref: string
  label: string
  kind: "text" | "textarea" | "select" | "radio" | "checkbox" | "file"
  required: boolean
  options?: string[]
  fieldName?: string
  fieldId?: string
  /** The ATS schema question backend code matched to this control (scope 05d). */
  schemaQuestion?: { text: string; fieldName: string; options?: string[] }
}

export type SubmissionState =
  | "queued"
  | "submit_claimed"
  | "submitting"
  | "confirmed"
  | "uncertain"
  | "blocked"
  | "manual"
  | "not_submitted"
  | "declined"
export type EvidenceKind = "confirmation_page" | "application_id" | "marked_confirmed"
export type BlockedReason =
  | "missing_approved_answer"
  | "login"
  | "email_verification"
  | "captcha"
  | "assessment"
  | "same_company_review"
  | "declaration"
  | "personal_data_request"
  | "automation_incomplete"
  | "ats_below_minimum"
export type BlockedSubReason = "budget" | "redirect" | "submit_attempt" | "value_mismatch"

export interface SubmissionDayTable {
  /** EPIC-0002 A1: the owning Candidate (0016), named on every write; RLS keys on it (0017). */
  candidate_id: string
  /** The Candidate's local date (for the Operator, the WAT date). */
  day: string
}

export interface ExistingApplicationTable {
  /** EPIC-0002 A1: the owning Candidate (0016), named on every write; RLS keys on it (0017). */
  candidate_id: string
  id: string
  company: string
  role_title: string
  application_url: string
  requisition_id: string | null
  applied_on: string
  created_at: Date
}

export interface ActivationStateTable {
  /** EPIC-0002 A1: the owning Candidate (0016), named on every write; RLS keys on it (0017). */
  candidate_id: string
  existing_applications_completed_at: Date | null
  gate_passed_at: Date | null
  automatic_enabled: Generated<boolean>
}

/** EPIC-0011 (migration 0033): one row per Candidate. A missing row reads as the defaults (off, no note). */
export interface CandidateViewSettingTable {
  candidate_id: string
  advanced_enabled: Generated<boolean>
  simpler_note_due: Generated<boolean>
  improve_list_dismissed_at: Date | null
  updated_at: Date
}

export interface SubmissionEventTable {
  /** EPIC-0002 A1: the owning Candidate (0016), named on every write; RLS keys on it (0017). */
  candidate_id: string
  id: string
  application_id: string | null
  kind: string
  detail: string | null
  created_at: Date
}

export type NotificationKind = "confirmed" | "blocked" | "uncertain" | "daily_summary" | "cost_pause" | "access_request" | "access_request_cap"
export type NotificationStatus = "pending" | "sending" | "sent" | "failed" | "skipped"
export type NotificationError = "auth_failed" | "send_refused" | "timeout" | "connection_failed" | "interrupted" | "unknown"

export interface NotificationOutboxTable {
  /**
   * EPIC-0002 A1: the owning Candidate (0016), named on every write; RLS keys on it (0017).
   * Null exactly for the installation kinds `access_request` and `access_request_cap` (C36).
   */
  candidate_id: string | null
  id: string
  application_id: string | null
  kind: NotificationKind
  created_at: Date
  sent_at: Date | null
  // Migration 0009 (slice 6): the sender's bookkeeping.
  /** `date` column, read as text; set only for `daily_summary` (the Candidate's local day) and `access_request_cap` (UTC day). 0016 renamed `wat_day`. */
  local_day: ColumnType<string | null, string | null | undefined, string | null>
  status: Generated<NotificationStatus>
  attempts: Generated<number>
  next_attempt_at: Generated<Date | null>
  claimed_at: Generated<Date | null>
  last_error: Generated<NotificationError | null>
  last_failed_at: Generated<Date | null>
  // Migration 0010 (slice 7): facts for the cost-pause email (E4).
  payload: ColumnType<CostPausePayload | null, string | null | undefined, string | null>
  // Migration 0014 (EPIC-0003): set only for `access_request`, the window's first request id.
  access_request_window_id: ColumnType<string | null, string | null | undefined, string | null>
}

export type AccessRequestStatus = "waiting" | "sent" | "failed"

/** EPIC-0003 (migration 0014). Installation-scoped; no Candidate code path reads it (AC 11.23). */
export interface AccessRequestTable {
  id: string
  email: string
  /** Lower-cased email: the 24-hour coalesce key. */
  email_key: string
  note: string
  created_at: Date
  /** HMAC of the normalized client IP; null after 24 hours. */
  ip_hash: string | null
  /** The id of the first request in this 24-hour window. */
  window_id: string
  status: Generated<AccessRequestStatus>
}

export type AccessRequestDropReason = "honeypot" | "fill_time"

export interface AccessRequestDropTable {
  id: string
  ip_hash: string
  reason: AccessRequestDropReason
  created_at: Date
}

/** E4 facts, captured when the pause starts. Money in micro-USD. */
export type CostPausePayload = {
  month: string
  spentMicros: number
  ceilingMicros: number
  action: string | null
  estimateMicros: number | null
  pausedAt: string
}

export type SpendCategory = "hosting" | "ai" | "browser" | "discovery" | "email"

export interface SpendMonthTable {
  /** `date`, first of the WAT month, read as text. */
  month: ColumnType<string, string, string>
  ceiling_micros: ColumnType<string, string | number | bigint, string | number | bigint>
  raised_at: Date | null
  created_at: Date
}

export interface SpendEntryTable {
  id: string
  month: ColumnType<string, string, string>
  category: SpendCategory
  sub_budget: "form_agent" | null
  purpose: string
  status: "reserved" | "settled" | "released"
  reserved_micros: ColumnType<string, string | number | bigint, string | number | bigint>
  actual_micros: ColumnType<string | null, string | number | bigint | null, string | number | bigint | null>
  application_id: string | null
  attempt_id: string | null
  created_at: Date
  settled_at: Date | null
}

export type OutcomeType = "confirmation" | "rejection" | "interview_invitation" | "request_for_action" | "offer"

export interface OutcomeTable {
  /** EPIC-0002 A1: the owning Candidate (0016), named on every write; RLS keys on it (0017). */
  candidate_id: string
  id: string
  application_id: string
  type: OutcomeType
  source: Generated<"candidate">
  excerpt: string | null
  created_at: Date
  updated_at: Date
}

export interface NotificationSenderStateTable {
  singleton: Generated<boolean>
  configured: boolean
  updated_at: Date
}

export interface TailoredDocumentTable {
  /** EPIC-0002 A1: the owning Candidate (0016), named on every write; RLS keys on it (0017). */
  candidate_id: string
  id: string
  application_id: string
  kind: "resume" | "cover_letter"
  career_profile_version: number
  content: ColumnType<Record<string, unknown>, string, string>
  pdf_storage_name: string
  docx_storage_name: string
  pdf_sha256: string
  docx_sha256: string
  created_at: Date
}

export type CandidateRole = "operator" | "candidate"

export interface CandidateTable {
  id: Generated<string>
  email: string | null
  google_sub: string | null
  role: CandidateRole
  state: Generated<"active" | "revoked" | "deleting">
  onboarded_at: Date | null
  created_at: Generated<Date>
  revoked_at: Date | null
}

/** EPIC-0002 A1 (0018): current Job Preferences per Candidate. Read by no code until slice B. */
export interface JobPreferencesTable {
  candidate_id: string
  version: number
  values: ColumnType<Record<string, unknown>, string, string>
  updated_at: Generated<Date>
}

/** Immutable history: one row per saved version. */
export interface JobPreferencesVersionTable {
  candidate_id: string
  version: number
  values: ColumnType<Record<string, unknown>, string, never>
  saved_at: Generated<Date>
}

/** Shared, immutable AI provider terms versions (0018, from the slice 2 approval). Read by no code until slice C. */
export interface AiTermsRecordTable {
  version: number
  provider: "anthropic"
  terms_checked_on: Date | string
  training_line: string
  retention_line: string
  whats_sent_line: string
  recorded_at: Date
}

/** A Candidate's approval of one terms version. */
export interface AiTermsApprovalTable {
  candidate_id: string
  terms_version: number
  approved_at: Date
}

export interface MigrationMarkerTable {
  name: string
  applied_at: Generated<Date>
}

export interface Database {
  candidate: CandidateTable
  migration_marker: MigrationMarkerTable
  job_preferences: JobPreferencesTable
  job_preferences_version: JobPreferencesVersionTable
  ai_terms_record: AiTermsRecordTable
  ai_terms_approval: AiTermsApprovalTable
  dashboard_session: DashboardSessionTable
  sign_in_attempt: SignInAttemptTable
  ai_provider_approval: AiProviderApprovalTable
  ai_call: AiCallTable
  resume_upload: ResumeUploadTable
  career_profile_version: CareerProfileVersionTable
  approved_answer: ApprovedAnswerTable
  gross_salary_answer: GrossSalaryAnswerTable
  preferred_net_pay: PreferredNetPayTable
  candidate_setting: CandidateSettingTable
  control_state: ControlStateTable
  evaluation_setting: EvaluationSettingTable
  job_criteria: JobCriteriaTable
  employer_list_state: EmployerListStateTable
  employer_board: EmployerBoardTable
  remote_board: RemoteBoardTable
  job_posting: JobPostingTable
  candidate_posting: CandidatePostingTable
  eligibility_result: EligibilityResultTable
  match_evidence: MatchEvidenceTable
  candidate_contact: CandidateContactTable
  application: ApplicationTable
  application_form_read: ApplicationFormReadTable
  tailored_document: TailoredDocumentTable
  submission_day: SubmissionDayTable
  existing_application: ExistingApplicationTable
  activation_state: ActivationStateTable
  candidate_view_setting: CandidateViewSettingTable
  submission_event: SubmissionEventTable
  notification_outbox: NotificationOutboxTable
  notification_sender_state: NotificationSenderStateTable
  spend_month: SpendMonthTable
  spend_entry: SpendEntryTable
  outcome: OutcomeTable
  alert_feed_candidate_verification: AlertFeedCandidateVerificationTable
  alert_feed: AlertFeedTable
  stack_post: StackPostTable
  stack_post_run: StackPostRunTable
  hiring_alert_feed: HiringAlertFeedTable
  hiring_post: HiringPostTable
  hiring_post_run: HiringPostRunTable
  hiring_feed_verification: HiringFeedVerificationTable
  access_request: AccessRequestTable
  access_request_drop: AccessRequestDropTable
  retention_run: RetentionRunTable
  lead: LeadTable
  outreach_message: OutreachMessageTable
}

/** v1.29.0 lead pipeline (migration 0038): the Candidate's own stage for a posting they hold. */
export interface LeadTable {
  candidate_id: string
  job_posting_id: string
  stage: "saved" | "applied" | "interviewing" | "offer" | "rejected"
  stage_changed_at: Date
  created_at: Date
}

/** A kept sentence of a Ready Outreach text, with the approved facts it cited (architecture r1 D1). */
export type StoredOutreachSentence = {
  kind: "statement" | "ask"
  text: string
  factIds: string[]
}

/** The run state of one Outreach row: `running` exactly while a Run is in flight (architecture r1 D10). */
export type OutreachMessageRunStatus = "idle" | "running"

/**
 * v1.31.0 EPIC-0014 Outreach messages (migration 0040). One row per (Candidate,
 * Application, kind): the Ready text, the Reader name, the run state, the last
 * failure's cause and, for a `blocked` Run only, the first failed sentence.
 *
 * `first_failed_sentence` is written explicitly as null by `claimRun`, so it is
 * a plain nullable column, not `Generated`. `sentences` is jsonb: the driver
 * takes and returns text.
 */
export interface OutreachMessageTable {
  /** EPIC-0002 A1: the owning Candidate, named on every write; forced RLS keys on it (0040). */
  candidate_id: string
  id: string
  application_id: string
  kind: "referral_request" | "introduction" | "application_note"
  /** As validated: 1 to 40 code points, or null when none is saved (D8). */
  reader_name: string | null
  /** The model-derived text without the greeting; null with `sentences`, `profile_version` and `written_at` (D1). */
  body: string | null
  /** The kept sentences in order, for audit. Never a dropped sentence. */
  sentences: ColumnType<StoredOutreachSentence[] | null, string | null | undefined, string | null>
  /** The approved Career Profile version the body was written from; positive. */
  profile_version: number | null
  written_at: Date | null
  /** A cause code (`^[a-z][a-z_]{0,39}$`), never text. Persists until the next Run starts or succeeds. */
  last_failure: string | null
  /** The first sentence that failed in a `blocked` Run, verbatim; non-null only with `last_failure = 'blocked'` and `idle` (r1). */
  first_failed_sentence: string | null
  run_status: Generated<OutreachMessageRunStatus>
  /** The claim token of the Run in flight: every finisher writes `where run_id = $mine`. */
  run_id: string | null
  run_started_at: Date | null
  created_at: Date
  updated_at: Date
}
