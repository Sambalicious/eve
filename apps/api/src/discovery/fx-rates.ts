/**
 * Fixed, dated exchange rates for the pay rule (AC 4.5, Candidate decision r1:
 * "Non-USD pay is converted to USD at a published exchange rate"). There is no
 * live FX call. Update the table, its date and the source together.
 *
 * Source: European Central Bank euro foreign exchange reference rates,
 * https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml, fetched
 * 2026-10-19 (the file was dated 2026-10-16). ECB quotes units per 1 EUR; USD per
 * unit of X is (USD per EUR) / (X per EUR), rounded to 6 decimals in `usdPerUnit`.
 */
export type FxTable = Readonly<{
  source: string
  /** The rates' publication date (YYYY-MM-DD). */
  date: string
  /** US dollars per one unit of each currency. */
  usdPerUnit: Readonly<Record<string, number>>
}>

const ECB_UNITS_PER_EUR: Readonly<Record<string, number>> = {
  USD: 1.1253,
  GBP: 0.84385,
  CAD: 1.5935,
  AUD: 1.6171,
  CHF: 0.9272,
  SEK: 11.145,
  NOK: 10.624,
  DKK: 7.4748,
  PLN: 4.37,
  CZK: 24.323,
  INR: 106.864,
  SGD: 1.4395,
  NZD: 1.9868,
  ZAR: 18.493,
  JPY: 177.82,
  BRL: 5.7197,
  MXN: 20.6871,
  ILS: 3.4822,
  TRY: 55.7328,
}

function usdPerUnit(): Record<string, number> {
  const usdPerEur = ECB_UNITS_PER_EUR.USD as number
  const table: Record<string, number> = { USD: 1, EUR: usdPerEur }
  for (const [code, perEur] of Object.entries(ECB_UNITS_PER_EUR)) {
    if (code === "USD") continue
    table[code] = Math.round((usdPerEur / perEur) * 1e6) / 1e6
  }
  return table
}

export const FX_RATES: FxTable = Object.freeze({
  source: "ECB euro reference rates, https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
  date: "2026-10-16",
  usdPerUnit: Object.freeze(usdPerUnit()),
})
