import { describe, expect, it } from "vitest"

import {
  pricesForModel,
  DEFAULT_SPEND_CONFIG,
  MAX_CEILING_MICROS,
  aiActualMicros,
  aiEstimateMicros,
  firstOfNextMonth,
  formatUsd,
  parseSpendEnv,
  parseUsdAmount,
  watMonth,
  wouldCross,
} from "./spend-math.js"

describe("money", () => {
  it.each([
    ["60", 60_000_000],
    ["62.50", 62_500_000],
    ["0.01", 10_000],
    ["100.00", 100_000_000],
  ])("parses %s", (text, micros) => expect(parseUsdAmount(text)).toBe(micros))

  it.each(["", " ", "sixty", "60.505", "-1", "1e3", "60.", ".5", "60,00"])("refuses %j", (text) => expect(parseUsdAmount(text)).toBeNull())

  it("formats micro-USD as dollars, rounding up to the cent", () => {
    expect(formatUsd(49_800_000)).toBe("49.80")
    expect(formatUsd(49_800_001)).toBe("49.81")
    expect(formatUsd(0)).toBe("0.00")
  })

  it("the most a raised ceiling can be is USD 100.00", () => expect(MAX_CEILING_MICROS).toBe(100_000_000))
})

describe("the ceiling check (cost-ceiling.feature boundary outlines)", () => {
  it.each([
    [49_500_000, 490_000, 50_000_000, false],
    [49_500_000, 500_000, 50_000_000, false],
    [49_500_000, 510_000, 50_000_000, true],
    [50_000_000, 10_000, 50_000_000, true],
    [59_500_000, 500_000, 60_000_000, false],
    [59_500_000, 510_000, 60_000_000, true],
  ])("spent %d + estimate %d against %d crosses: %s", (spent, estimate, ceiling, crosses) => {
    expect(wouldCross(spent, estimate, ceiling)).toBe(crosses)
  })
})

describe("WAT months", () => {
  it.each([
    ["2026-10-31T22:59:59Z", "2026-10-01"],
    ["2026-10-31T23:00:00Z", "2026-11-01"],
    ["2026-11-01T00:00:00+01:00", "2026-11-01"],
    ["2026-10-31T23:59:59+01:00", "2026-10-01"],
  ])("%s is in the WAT month %s", (at, month) => expect(watMonth(new Date(at))).toBe(month))

  it("rolls the year", () => expect(firstOfNextMonth("2026-12-01")).toBe("2027-01-01"))
})

describe("AI cost (prices are per million tokens, in micro-USD)", () => {
  const prices = { inputMicrosPerMTok: 100_000, outputMicrosPerMTok: 500_000 }

  it("estimates from the prompt size (3 characters a token, rounded up) and the full output allowance", () => {
    // 3,000 characters -> 1,000 input tokens -> 100 micro-USD; 600 output tokens -> 300 micro-USD.
    expect(aiEstimateMicros(prices, 3_000, 600)).toBe(400)
  })

  it("settles from reported usage, cache writes at 1.25x input", () => {
    expect(aiActualMicros(prices, { inputTokens: 10_000, outputTokens: 2_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, 0)).toBe(2_000)
    expect(aiActualMicros(prices, { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 8_000 }, 0)).toBe(1_000)
  })

  // AC 10.5: the provider's (or a fake's) usage report can make the cost higher, never lower than what was sent.
  it("never settles below the input that was sent, whatever the usage says", () => {
    expect(aiActualMicros(prices, { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, 300)).toBe(300)
  })

  it("treats missing, negative or non-finite usage as the full reservation", () => {
    const reserved = 5_000
    expect(aiActualMicros(prices, { inputTokens: null, outputTokens: null, cacheReadInputTokens: null, cacheCreationInputTokens: null }, 300, reserved)).toBe(reserved)
    expect(aiActualMicros(prices, { inputTokens: -5, outputTokens: 10, cacheReadInputTokens: null, cacheCreationInputTokens: null }, 300, reserved)).toBe(reserved)
    expect(aiActualMicros(prices, { inputTokens: Number.NaN, outputTokens: 10, cacheReadInputTokens: null, cacheCreationInputTokens: null }, 300, reserved)).toBe(reserved)
  })

  it("records huge reported usage as huge cost", () => {
    expect(aiActualMicros(prices, { inputTokens: 1_000_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, 0)).toBe(100_000_000)
  })
})

describe("spend configuration (env only; the ceiling can never be configured above USD 50)", () => {
  it("defaults", () => {
    expect(parseSpendEnv({})).toEqual(DEFAULT_SPEND_CONFIG)
    expect(DEFAULT_SPEND_CONFIG.ceilingMicros).toBe(50_000_000)
    expect(DEFAULT_SPEND_CONFIG.formAgent).toEqual({ perAttemptMicros: 30_000, monthlyMicros: 5_000_000 })
  })

  it("accepts a lower ceiling", () => expect(parseSpendEnv({ SPEND_CEILING_USD: "30" }).ceilingMicros).toBe(30_000_000))

  it.each(["50.01", "100", "0", "abc"])("refuses SPEND_CEILING_USD=%s, naming the key only", (value) => {
    expect(() => parseSpendEnv({ SPEND_CEILING_USD: value })).toThrow(/SPEND_CEILING_USD/)
  })

  it("reads prices and the hosting accrual", () => {
    const config = parseSpendEnv({ SPEND_HOSTING_MONTHLY_USD: "24", SPEND_AI_INPUT_USD_PER_MTOK: "0.10", SPEND_AI_OUTPUT_USD_PER_MTOK: "0.50", SPEND_BROWSER_ATTEMPT_USD: "0.02" })
    expect(config.hostingMonthlyMicros).toBe(24_000_000)
    expect(config.ai).toEqual({ inputMicrosPerMTok: 100_000, outputMicrosPerMTok: 500_000 })
    expect(config.browserAttemptMicros).toBe(20_000)
  })

  it("never prices a known model below its list price, and leaves unknown models as configured", () => {
    const haiku = { inputMicrosPerMTok: 100_000, outputMicrosPerMTok: 500_000 }
    expect(pricesForModel("claude-sonnet-5-5", haiku)).toEqual({ inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000 })
    expect(pricesForModel("claude-haiku-5-5", haiku)).toEqual(haiku)
    const dearer = { inputMicrosPerMTok: 9_000_000, outputMicrosPerMTok: 90_000_000 }
    expect(pricesForModel("claude-sonnet-5-5", dearer)).toEqual(dearer)
    expect(pricesForModel("some-future-model", haiku)).toEqual(haiku)
  })

  it("prices tailored documents at Sonnet 5.5 list price unless overridden", () => {
    expect(parseSpendEnv({}).documentsAi).toEqual({ inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000 })
    const config = parseSpendEnv({ SPEND_DOCUMENTS_AI_INPUT_USD_PER_MTOK: "3", SPEND_DOCUMENTS_AI_OUTPUT_USD_PER_MTOK: "15" })
    expect(config.documentsAi).toEqual({ inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 })
    expect(() => parseSpendEnv({ SPEND_DOCUMENTS_AI_OUTPUT_USD_PER_MTOK: "0" })).toThrow(/SPEND_DOCUMENTS_AI_OUTPUT_USD_PER_MTOK/)
  })
})
