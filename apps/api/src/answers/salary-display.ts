const PERIOD_LABEL = { year: "per year", month: "per month", month_net: "per month net" } as const

/** "USD 48,000 per year", "USD 5,000 per month net": the wording the Gherkin and dashboard use. */
export function formatSalary(amount: string, currency: string, period: keyof typeof PERIOD_LABEL): string {
  const value = Number(amount)
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value)
  return `${currency} ${formatted} ${PERIOD_LABEL[period]}`
}
