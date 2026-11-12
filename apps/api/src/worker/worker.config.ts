import { z } from "zod"

import { type AnthropicConfig, DEFAULT_DOCUMENTS_MODEL, RETIRED_STORAGE_KEYS, anthropicConfig, invalidKeysMessage, optionalApiKeySchema, retiredSubSchema } from "../config/env.js"
import { type MailerConfig, parseMailerEnv } from "../notification/mailer-config.js"
import { type SpendConfig, parseSpendEnv } from "../spend/spend-math.js"

const workerEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Slice 3: posting evaluation goes through ModelGateway in the worker. Optional, as in the api. */
  ANTHROPIC_API_KEY: optionalApiKeySchema,
  ANTHROPIC_MODEL: z.string().trim().min(1).default("claude-haiku-5-5"),
  ANTHROPIC_DOCUMENTS_MODEL: z.string().trim().min(1).default(DEFAULT_DOCUMENTS_MODEL),
  /** Slice 5: the submission service reads Tailored Document files to upload them. A2: the per-Candidate root, mounted read-only. */
  CANDIDATE_STORAGE_DIR: z.string().trim().min(1).default("/data/candidates"),
  /** ADR 0008: the Playwright MCP browser is off unless this is exactly "1". */
  SUBMISSION_BROWSER_ENABLED: z.string().optional(),
  SUBMISSION_BROWSER_MCP_URL: z.url({ protocol: /^https?$/ }).default("http://browser:8931/mcp"),
  SUBMISSION_UPLOAD_DIR: z.string().trim().min(1).default("/data/uploads"),
  SUBMISSION_UPLOAD_DIR_IN_BROWSER: z.string().trim().min(1).default("/home/node/uploads"),
  SUBMISSION_EGRESS_ALLOWLIST_FILE: z.string().trim().min(1).default("/data/egress/allowlist.txt"),
  /** Repair wave 3 (SEC-515): the form agent is off unless this is exactly "1" (default "0"). */
  SUBMISSION_FORM_AGENT_ENABLED: z.string().optional(),
  /** EPIC-0012: the worker runs document generation too, so it reads the same two flags (on only for "1"). */
  DOCUMENT_BRIDGES_ENABLED: z.string().optional(),
  DOCUMENT_DIRECTION_ENABLED: z.string().optional(),
  /** JSON object: application host -> reviewed extra hosts its form needs. */
  SUBMISSION_REVIEWED_HOSTS_FILE: z.string().trim().min(1).optional(),
  /** Slice 6: the daily summary job is off unless this is exactly "1". */
  NOTIFY_DAILY_SUMMARY_ENABLED: z.string().optional(),
  /** Retired (EPIC-0002 A1): the worker refuses a leftover value exactly as the api does. */
  CANDIDATE_GOOGLE_SUB: retiredSubSchema,
  /** Retired (EPIC-0002 A2): read only by storage:migrate. */
  ...RETIRED_STORAGE_KEYS,
  /** Automatic expiry (E3.8): exactly "1" unschedules retention.daily. Any other value, or none, schedules it. */
  RETENTION_JOB_DISABLED: z.string().optional(),
})

export type BrowserConfig = Readonly<{
  mcpUrl: string
  uploadDir: string
  uploadDirInBrowser: string
  allowlistFile: string
  reviewedHostsFile: string | null
}>

export type WorkerConfig = Readonly<{
  databaseUrl: string
  anthropic: AnthropicConfig
  /** EPIC-0002 A2: CandidateFiles root (read-only in the worker). */
  candidateStorageDir: string
  /** Off unless SUBMISSION_FORM_AGENT_ENABLED=1. */
  formAgentEnabled?: boolean
  /** Off unless DOCUMENT_BRIDGES_ENABLED=1 (EPIC-0012 rule 2). */
  documentBridgesEnabled?: boolean
  /** Off unless DOCUMENT_DIRECTION_ENABLED=1 (EPIC-0012 rule 4). */
  documentDirectionEnabled?: boolean
  /** Null: no browser, so the worker cannot submit (the default). */
  browser?: BrowserConfig | null
  /** Slice 6. Null: no Gmail SMTP settings, so nothing is sent and outbox rows stay pending. */
  mailer?: MailerConfig | null
  /** Mailer env keys that were set but invalid or missing (names only, for the start-up log). */
  mailerMissing?: readonly string[]
  /** Off unless NOTIFY_DAILY_SUMMARY_ENABLED=1. */
  dailySummaryEnabled?: boolean
  /** Slice 7: ceiling, prices and caps (`SPEND_*`). Defaults when absent. */
  spend?: SpendConfig
  /** Automatic expiry: true only when RETENTION_JOB_DISABLED=1 (E3.8). */
  retentionJobDisabled?: boolean
}>

/** The worker needs the database and the Anthropic settings; it must not require dashboard OAuth secrets. */
export function parseWorkerConfig(env: Readonly<Record<string, string | undefined>>): WorkerConfig {
  const result = workerEnvSchema.safeParse(env)
  if (!result.success) {
    throw new Error(invalidKeysMessage(result.error.issues).message)
  }
  const mailer = parseMailerEnv(env)
  const spend = parseSpendEnv(env)
  return {
    spend,
    databaseUrl: result.data.DATABASE_URL,
    mailer: mailer.config,
    mailerMissing: mailer.missing,
    dailySummaryEnabled: result.data.NOTIFY_DAILY_SUMMARY_ENABLED === "1",
    retentionJobDisabled: result.data.RETENTION_JOB_DISABLED === "1",
    anthropic: anthropicConfig(result.data.ANTHROPIC_API_KEY, result.data.ANTHROPIC_MODEL, result.data.ANTHROPIC_DOCUMENTS_MODEL),
    candidateStorageDir: result.data.CANDIDATE_STORAGE_DIR,
    formAgentEnabled: result.data.SUBMISSION_FORM_AGENT_ENABLED === "1",
    documentBridgesEnabled: result.data.DOCUMENT_BRIDGES_ENABLED === "1",
    documentDirectionEnabled: result.data.DOCUMENT_DIRECTION_ENABLED === "1",
    browser:
      result.data.SUBMISSION_BROWSER_ENABLED === "1"
        ? {
            mcpUrl: result.data.SUBMISSION_BROWSER_MCP_URL,
            uploadDir: result.data.SUBMISSION_UPLOAD_DIR,
            uploadDirInBrowser: result.data.SUBMISSION_UPLOAD_DIR_IN_BROWSER,
            allowlistFile: result.data.SUBMISSION_EGRESS_ALLOWLIST_FILE,
            reviewedHostsFile: result.data.SUBMISSION_REVIEWED_HOSTS_FILE ?? null,
          }
        : null,
  }
}
