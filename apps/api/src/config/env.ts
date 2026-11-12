import { z } from "zod"

import { type AccessRequestKeys, accessRequestKeys } from "../access-request/access-request-keys.js"
import { API_STATEMENT_TIMEOUT_MS } from "../db/statement-timeouts.js"
import { type SpendConfig, SpendEnvError, parseSpendEnv } from "../spend/spend-math.js"

const DEFAULT_PORT = 3000

export const RETIRED_SUB_MESSAGE = "CANDIDATE_GOOGLE_SUB must be removed after the multi-candidate migration"

/**
 * The Anthropic key is optional. Compose passes `${ANTHROPIC_API_KEY:-}`, so an
 * unset key arrives as an empty string; blank means unset (F-QA5-02).
 */
const wholeNumber = (min: number, fallback: number) =>
  z
    .string()
    .regex(/^\d{1,9}$/)
    .default(String(fallback))
    .transform(Number)
    .pipe(z.number().int().min(min))

/**
 * Retired (EPIC-0002 A1): the api and the worker refuse a set value with fixed
 * text that never echoes it (migration-and-operator-bootstrap.feature:891).
 * Blank (compose `${X:-}`) counts as unset.
 */
export const retiredSubSchema = z
  .string()
  .optional()
  .refine((value) => value === undefined || value.trim() === "", { message: RETIRED_SUB_MESSAGE })

/** EPIC-0002 A2: the pre-A2 flat storage keys, read only by storage:migrate (as OLD_*). Fixed text, never the value. */
export const retiredStorageKeyMessage = (key: string) => `${key} must be removed after storage:migrate`
export const retiredStorageSchema = (key: string) =>
  z
    .string()
    .optional()
    .refine((value) => value === undefined || value.trim() === "", { message: retiredStorageKeyMessage(key) })
export const RETIRED_STORAGE_KEYS = {
  RESUME_STORAGE_DIR: retiredStorageSchema("RESUME_STORAGE_DIR"),
  DOCUMENT_STORAGE_DIR: retiredStorageSchema("DOCUMENT_STORAGE_DIR"),
}

/** The fixed start-up error for invalid keys: names only, plus the retirement text when that key failed. */
export function invalidKeysMessage(issues: readonly Readonly<{ path: readonly PropertyKey[]; message: string }>[]): { keys: string[]; message: string } {
  const keys = [...new Set(issues.map((issue) => issue.path.map(String).join(".")))]
  const retired = [...new Set(issues.map((issue) => issue.message).filter((message) => message === RETIRED_SUB_MESSAGE || message.endsWith(" must be removed after storage:migrate")))]
  const base = `Invalid or missing environment variables: ${keys.join(", ")}`
  return { keys, message: retired.length > 0 ? `${retired.join("; ")}; invalid keys: ${keys.join(", ")}` : base }
}

export const optionalApiKeySchema = z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), z.string().trim().min(1).optional())

/** Tailoring writes what employers read, so it gets a stronger model than scoring. */
export const DEFAULT_DOCUMENTS_MODEL = "claude-sonnet-5-5"

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_PORT),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Origin the Candidate's browser uses for the dashboard and /v1, e.g. https://jobs.example.com. */
  PUBLIC_ORIGIN: z
    .url({ protocol: /^https?$/ })
    .transform((value) => new URL(value).origin),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  /**
   * Retired (EPIC-0002 A1, architecture r2): only `migrate.cli.ts` reads it, once.
   * The api boots only after the multi-candidate marker exists, so a set value is
   * a leftover; blank (compose `${X:-}`) counts as unset.
   */
  CANDIDATE_GOOGLE_SUB: retiredSubSchema,
  /** Retired (EPIC-0002 A2): read only by storage:migrate. */
  ...RETIRED_STORAGE_KEYS,
  /** Anthropic API key from the environment only (Candidate decision). Optional so the
   * dashboard still runs; drafting then fails with `ai_provider_not_configured`. */
  ANTHROPIC_API_KEY: optionalApiKeySchema,
  /** Cheapest current model: platform.claude.com/docs/en/about-claude/models/overview (2026-10-17). */
  ANTHROPIC_MODEL: z.string().trim().min(1).default("claude-haiku-5-5"),
  /** Tailored resume and cover letter only. Scoring and everything else stay on ANTHROPIC_MODEL. */
  ANTHROPIC_DOCUMENTS_MODEL: z.string().trim().min(1).default(DEFAULT_DOCUMENTS_MODEL),
  /**
   * EPIC-0002 A2: the per-Candidate file root, `<root>/<candidate_id>/{resumes,documents,exports}`.
   * The api refuses to start until `storage:migrate` has marked it complete.
   */
  CANDIDATE_STORAGE_DIR: z.string().trim().min(1).default("/data/candidates"),
  /** Repair wave 3 (SEC-515): the form agent is off unless this is exactly "1" (default "0"). */
  SUBMISSION_FORM_AGENT_ENABLED: z.string().optional(),
  /** EPIC-0012 (Revision 2, 2.4): tailoring rule 2, bridging with the posting's field words. On only for "1". */
  DOCUMENT_BRIDGES_ENABLED: z.string().optional(),
  /** EPIC-0012 (Revision 2, 2.4): tailoring rule 4, quoting the employer's own forward-looking words. On only for "1". */
  DOCUMENT_DIRECTION_ENABLED: z.string().optional(),
  /** EPIC-0003: HMAC root for the access-request IP hash and fill-time proof. At least 32 bytes. */
  ACCESS_REQUEST_SECRET: z.string().refine((value) => Buffer.byteLength(value, "utf8") >= 32),
  /** Reverse-proxy hops to trust for the client address. Production behind Caddy: 1. */
  TRUST_PROXY: wholeNumber(0, 0),
  ACCESS_REQUEST_LIMIT_IP_HOUR: wholeNumber(1, 3),
  ACCESS_REQUEST_LIMIT_IP_DAY: wholeNumber(1, 10),
  ACCESS_REQUEST_LIMIT_GLOBAL_DAY: wholeNumber(1, 50),
})

export type AppConfig = Readonly<{
  nodeEnv: "development" | "test" | "production"
  host: string
  port: number
  databaseUrl: string
  publicOrigin: string
  googleClientId: string
  googleClientSecret: string
  anthropic: AnthropicConfig
  /** EPIC-0002 A2: CandidateFiles root. */
  candidateStorageDir: string
  /** Off by default: leftover required fields block as Missing Approved Answer and no model is called. */
  formAgentEnabled: boolean
  /** Off unless DOCUMENT_BRIDGES_ENABLED=1 (EPIC-0012 rule 2). */
  documentBridgesEnabled: boolean
  /** Off unless DOCUMENT_DIRECTION_ENABLED=1 (EPIC-0012 rule 4). */
  documentDirectionEnabled: boolean
  /** Slice 7: ceiling, prices and caps from the server environment (`SPEND_*`). */
  spend?: SpendConfig
  /** EPIC-0003: the public request-access endpoint. */
  accessRequest: AccessRequestConfig
  /** Slice 8d (8d.9): the api pool's `statement_timeout`, `API_STATEMENT_TIMEOUT_MS`. Not configurable from the environment. */
  statementTimeoutMs: number
}>

export type AccessRequestLimits = Readonly<{ perIpHour: number; perIpDay: number; globalDay: number }>

export type AccessRequestConfig = Readonly<{
  /** Fastify `trustProxy` hops. 0 disables the per-IP rule (every visitor would share the proxy address). */
  trustProxy: number
  limits: AccessRequestLimits
  /** Subkeys in a closure; the secret itself is not kept. */
  keys: AccessRequestKeys
}>

/** The part of the config shared by the api and the worker: what ModelGateway and DatabaseModule read. */
export type SharedRuntimeConfig = Pick<AppConfig, "databaseUrl" | "anthropic" | "statementTimeoutMs"> & Readonly<{ formAgentEnabled?: boolean; documentBridgesEnabled?: boolean; documentDirectionEnabled?: boolean; spend?: SpendConfig }>

/**
 * The key is held in a closure, so serialising or logging the config never
 * reveals it: JSON.stringify and util.inspect see only `apiKeyConfigured`.
 */
export type AnthropicConfig = Readonly<{
  /** Scoring, Career Profile drafting and the form agent. */
  model: string
  /** Tailored documents. Unset means `model`. */
  documentsModel?: string
  apiKeyConfigured: boolean
  readApiKey(): string | undefined
}>

export function anthropicConfig(apiKey: string | undefined, model: string, documentsModel: string = model): AnthropicConfig {
  return Object.freeze({
    model,
    documentsModel,
    apiKeyConfigured: apiKey !== undefined,
    readApiKey: () => apiKey,
  })
}

export class InvalidConfigError extends Error {
  constructor(readonly invalidKeys: readonly string[], detail?: string) {
    super(detail ?? `Invalid or missing environment variables: ${invalidKeys.join(", ")}`)
    this.name = "InvalidConfigError"
  }
}

/** Parses process environment once at boot. Error messages name keys, never values. */
export function parseConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const result = envSchema.safeParse(env)
  if (!result.success) {
    // The retirement message is fixed text (never the value), so it is safe to show.
    const { keys, message } = invalidKeysMessage(result.error.issues)
    throw new InvalidConfigError(keys, message)
  }
  const parsed = result.data
  let spend: SpendConfig
  try {
    spend = parseSpendEnv(env)
  } catch (error) {
    if (error instanceof SpendEnvError) throw new InvalidConfigError(error.invalidKeys)
    throw error
  }
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    publicOrigin: parsed.PUBLIC_ORIGIN,
    googleClientId: parsed.GOOGLE_CLIENT_ID,
    googleClientSecret: parsed.GOOGLE_CLIENT_SECRET,
    anthropic: anthropicConfig(parsed.ANTHROPIC_API_KEY, parsed.ANTHROPIC_MODEL, parsed.ANTHROPIC_DOCUMENTS_MODEL),
    candidateStorageDir: parsed.CANDIDATE_STORAGE_DIR,
    formAgentEnabled: parsed.SUBMISSION_FORM_AGENT_ENABLED === "1",
    documentBridgesEnabled: parsed.DOCUMENT_BRIDGES_ENABLED === "1",
    documentDirectionEnabled: parsed.DOCUMENT_DIRECTION_ENABLED === "1",
    spend,
    accessRequest: {
      trustProxy: parsed.TRUST_PROXY,
      limits: {
        perIpHour: parsed.ACCESS_REQUEST_LIMIT_IP_HOUR,
        perIpDay: parsed.ACCESS_REQUEST_LIMIT_IP_DAY,
        globalDay: parsed.ACCESS_REQUEST_LIMIT_GLOBAL_DAY,
      },
      keys: accessRequestKeys(parsed.ACCESS_REQUEST_SECRET),
    },
    statementTimeoutMs: API_STATEMENT_TIMEOUT_MS,
  }
}
