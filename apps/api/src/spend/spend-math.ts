import type { TokenUsage } from "../ai/ai-call.repository.js"

/**
 * Money, months and prices for the cost ceiling (prd.r4.md AC 10.2, 10.5).
 * All amounts are integer micro-USD (1 USD = 1,000,000), so sums are exact and
 * nothing a model returns can change a limit: every limit here is a constant
 * or comes from the server environment.
 */
export const MICROS_PER_USD = 1_000_000

/** prd.r4.md AC 10.2: the default monthly ceiling. Configurable lower only. */
export const DEFAULT_CEILING_MICROS = 50_000_000
/** r3 Candidate decision: a raised ceiling is at most USD 100.00, current month only. */
export const MAX_CEILING_MICROS = 100_000_000

/** ADR 0008 / architecture r1: form-agent caps, USD 0.03 per attempt and USD 5 a month. */
export const FORM_AGENT_CAPS = Object.freeze({ perAttemptMicros: 30_000, monthlyMicros: 5_000_000 })

/** Estimating input tokens from characters: 3 characters a token over-counts English, so the estimate errs high. */
const CHARS_PER_TOKEN = 3
/** Anthropic bills cache writes at 1.25x the input price. */
const CACHE_WRITE_FACTOR = 1.25

export type AiPrices = Readonly<{ inputMicrosPerMTok: number; outputMicrosPerMTok: number }>

export type SpendConfig = Readonly<{
  ceilingMicros: number
  hostingMonthlyMicros: number
  ai: AiPrices
  /** Prices for the tailored-documents model when it differs from the default one. Unset means Sonnet 5.5 list price. */
  documentsAi?: AiPrices
  browserAttemptMicros: number
  discoveryRunMicros: number
  emailMicros: number
  formAgent: Readonly<{ perAttemptMicros: number; monthlyMicros: number }>
}>

/** Sonnet 5.5 list price: USD 2.00 / 10.00 per million tokens (tailored documents). */
export const DEFAULT_DOCUMENTS_AI_PRICES: AiPrices = Object.freeze({ inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000 })

/**
 * List prices for the models Eve is set up with. A call is never reserved below
 * the list price of the model it actually uses, whatever the SPEND_* settings
 * say, so pointing a setting at a dearer model cannot slip past the ceiling.
 */
const KNOWN_MODEL_PRICES: Readonly<Record<string, AiPrices>> = Object.freeze({
  "claude-haiku-5-5": Object.freeze({ inputMicrosPerMTok: 100_000, outputMicrosPerMTok: 500_000 }),
  "claude-sonnet-5-5": Object.freeze({ inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000 }),
  "claude-opus-5-5": Object.freeze({ inputMicrosPerMTok: 4_000_000, outputMicrosPerMTok: 20_000_000 }),
})

/** The configured prices, raised to the model's list price where that is higher. Unknown models keep the configured prices. */
export function pricesForModel(model: string, configured: AiPrices): AiPrices {
  const known = KNOWN_MODEL_PRICES[model]
  if (!known) return configured
  return {
    inputMicrosPerMTok: Math.max(configured.inputMicrosPerMTok, known.inputMicrosPerMTok),
    outputMicrosPerMTok: Math.max(configured.outputMicrosPerMTok, known.outputMicrosPerMTok),
  }
}

/** Haiku 5.5 list price (architecture r1 [S13]): USD 0.10 / 0.50 per million tokens. Hosting: USD 24 (architecture r1). */
export const DEFAULT_SPEND_CONFIG: SpendConfig = Object.freeze({
  ceilingMicros: DEFAULT_CEILING_MICROS,
  hostingMonthlyMicros: 24_000_000,
  ai: Object.freeze({ inputMicrosPerMTok: 100_000, outputMicrosPerMTok: 500_000 }),
  documentsAi: DEFAULT_DOCUMENTS_AI_PRICES,
  browserAttemptMicros: 0,
  discoveryRunMicros: 0,
  emailMicros: 0,
  formAgent: FORM_AGENT_CAPS,
})

/** "60" or "62.50": at most two decimals, no sign, no exponent. Null when not an amount. */
export function parseUsdAmount(text: string): number | null {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text)
  if (!match) return null
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"))
  return cents * 10_000
}

/** Two-decimal dollars, rounded up to the cent so a displayed total never understates spend. */
export function formatUsd(micros: number): string {
  const cents = Math.ceil(micros / 10_000)
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`
}

/** cost-ceiling.feature: a total that reaches exactly the ceiling proceeds; only "above" pauses. */
export function wouldCross(spentMicros: number, estimateMicros: number, ceilingMicros: number): boolean {
  return spentMicros + estimateMicros > ceilingMicros
}

const WAT_OFFSET_MS = 60 * 60 * 1000

/** First day (YYYY-MM-01) of the WAT calendar month of `at`. Africa/Lagos is UTC+1 all year. */
export function watMonth(at: Date): string {
  return `${new Date(at.getTime() + WAT_OFFSET_MS).toISOString().slice(0, 7)}-01`
}

export function firstOfNextMonth(month: string): string {
  const next = new Date(`${month}T00:00:00Z`)
  next.setUTCMonth(next.getUTCMonth() + 1)
  return next.toISOString().slice(0, 10)
}

/** 00:00 WAT on the first of `month`, as an instant. */
export function startOfWatMonth(month: string): Date {
  return new Date(new Date(`${month}T00:00:00Z`).getTime() - WAT_OFFSET_MS)
}

/** The most a call can cost: every prompt character a token-third, and the whole output allowance. */
export function aiEstimateMicros(prices: AiPrices, promptChars: number, maxOutputTokens: number): number {
  const inputTokens = Math.ceil(promptChars / CHARS_PER_TOKEN)
  return Math.ceil((inputTokens * prices.inputMicrosPerMTok + maxOutputTokens * prices.outputMicrosPerMTok) / 1_000_000)
}

function usable(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0
}

/**
 * The cost to record for a finished call. Reported usage can raise it (a
 * provider or fake that reports huge usage is charged that), but never lower
 * it below `floorMicros`, the input actually sent. Usage that is missing or
 * nonsensical is charged the full reservation.
 */
export function aiActualMicros(prices: AiPrices, usage: TokenUsage, floorMicros: number, reservedMicros = floorMicros): number {
  const parts = [usage.inputTokens, usage.outputTokens]
  if (!parts.every(usable)) return Math.max(reservedMicros, floorMicros)
  const cacheRead = usable(usage.cacheReadInputTokens) ? usage.cacheReadInputTokens : 0
  const cacheWrite = usable(usage.cacheCreationInputTokens) ? usage.cacheCreationInputTokens : 0
  const input = (usage.inputTokens as number) + cacheRead * 0.1 + cacheWrite * CACHE_WRITE_FACTOR
  const cost = Math.ceil((input * prices.inputMicrosPerMTok + (usage.outputTokens as number) * prices.outputMicrosPerMTok) / 1_000_000)
  return Math.max(cost, floorMicros)
}

/** The input part of an estimate: what is spent once the request is sent, even if no usage comes back. */
export function aiInputMicros(prices: AiPrices, promptChars: number): number {
  return Math.ceil((Math.ceil(promptChars / CHARS_PER_TOKEN) * prices.inputMicrosPerMTok) / 1_000_000)
}

export class SpendEnvError extends Error {
  constructor(readonly invalidKeys: readonly string[]) {
    super(`Invalid spend environment variables: ${invalidKeys.join(", ")}`)
    this.name = "SpendEnvError"
  }
}

/**
 * Reads the spend settings from the server environment. The ceiling can be set
 * lower than USD 50 but never higher without a code change. Errors name keys only.
 */
export function parseSpendEnv(env: Readonly<Record<string, string | undefined>>): SpendConfig {
  const bad: string[] = []
  const amount = (key: string, fallback: number, check: (micros: number) => boolean = () => true): number => {
    const raw = env[key]
    if (raw === undefined || raw.trim() === "") return fallback
    const micros = parseUsdAmount(raw.trim())
    if (micros === null || !check(micros)) {
      bad.push(key)
      return fallback
    }
    return micros
  }
  const ceilingMicros = amount("SPEND_CEILING_USD", DEFAULT_CEILING_MICROS, (m) => m > 0 && m <= DEFAULT_CEILING_MICROS)
  const config: SpendConfig = {
    ceilingMicros,
    hostingMonthlyMicros: amount("SPEND_HOSTING_MONTHLY_USD", DEFAULT_SPEND_CONFIG.hostingMonthlyMicros, (m) => m <= ceilingMicros),
    ai: {
      inputMicrosPerMTok: amount("SPEND_AI_INPUT_USD_PER_MTOK", DEFAULT_SPEND_CONFIG.ai.inputMicrosPerMTok, (m) => m > 0),
      outputMicrosPerMTok: amount("SPEND_AI_OUTPUT_USD_PER_MTOK", DEFAULT_SPEND_CONFIG.ai.outputMicrosPerMTok, (m) => m > 0),
    },
    documentsAi: {
      inputMicrosPerMTok: amount("SPEND_DOCUMENTS_AI_INPUT_USD_PER_MTOK", DEFAULT_DOCUMENTS_AI_PRICES.inputMicrosPerMTok, (m) => m > 0),
      outputMicrosPerMTok: amount("SPEND_DOCUMENTS_AI_OUTPUT_USD_PER_MTOK", DEFAULT_DOCUMENTS_AI_PRICES.outputMicrosPerMTok, (m) => m > 0),
    },
    browserAttemptMicros: amount("SPEND_BROWSER_ATTEMPT_USD", DEFAULT_SPEND_CONFIG.browserAttemptMicros),
    discoveryRunMicros: amount("SPEND_DISCOVERY_RUN_USD", DEFAULT_SPEND_CONFIG.discoveryRunMicros),
    emailMicros: amount("SPEND_EMAIL_USD", DEFAULT_SPEND_CONFIG.emailMicros),
    formAgent: FORM_AGENT_CAPS,
  }
  if (bad.length > 0) throw new SpendEnvError(bad)
  return config
}
