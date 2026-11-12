import type { IndustryKey } from "@eve/contracts"

import { type RuleOutcome, foldForKeywords, sentencesOf } from "./rule-result.js"

/**
 * AC 4.7 and 5.11 keyword floor per catalog industry (`industryKeySchema`).
 * A match on the model's business summary, or any sentence of the posting text
 * with one of the terms of an industry the Candidate excludes, violates
 * whatever the model said (SEC-303). The terms name a business, not a role
 * feature, so "Gamified Learning", "gaming" or "Blockchain Analytics
 * Dashboard" alone does not match. Catalog data, not Candidate values: which
 * industries apply is the evaluated Candidate's `excludedIndustries`. The four
 * EPIC-0001 industries keep their patterns and order, so the Operator's
 * results are unchanged.
 */
const INDUSTRY_TERMS: Readonly<Record<IndustryKey, readonly RegExp[]>> = {
  adult_content: [/\badult (content|entertainment|video|site|films?|streaming)s?\b/, /\bporn(ography|ographic)?\b/],
  video_games_and_gaming_platforms: [/\b(video ?games?|mobile games?|game studio|games studio|gaming (platform|company|studio))\b/, /\bonline gaming\b/, /\besports?\b/],
  gambling: [/\b(casino|igaming|i-gaming|gambling|lottery|slot games?|poker)\b/],
  betting: [/\b(sports ?betting|betting|bookmaker|sportsbook|wager(s|ing|ed)?|bets)\b/],
  crypto_and_web3: [/\b(crypto|cryptocurrenc(y|ies)|crypto[- ]?exchanges?|web ?3|web3\.0|bitcoin|defi|nfts?|stablecoins?|digital assets? exchanges?)\b/],
  weapons_and_defense: [/\b(weapons?|firearms?|guns?|ammunition|munitions?|arms (manufacturer|dealer|maker|industry)|defen[cs]e (contractor|company|manufacturer|industry|drones?)|military drones?)\b/],
  tobacco_and_vaping: [/\b(tobacco|cigarettes?|e-?cigarettes?|cigars?|nicotine|vap(e|es|ing)|vaporizers?)\b/],
}

/** The terms of the industries `excluded` names, in catalog order. An unknown key adds nothing. */
function termsFor(excluded: readonly string[]): RegExp[] {
  return (Object.keys(INDUSTRY_TERMS) as IndustryKey[]).filter((key) => excluded.includes(key)).flatMap((key) => INDUSTRY_TERMS[key])
}

export function evaluateIndustry(input: Readonly<{
  postingText: string
  employerBusiness: string | null
  businessQuote: string | null
  /** The evaluated Candidate's excluded industries (`industryKeySchema` keys). Empty: nothing is excluded. */
  excludedIndustries: readonly string[]
}>): RuleOutcome {
  const terms = termsFor(input.excludedIndustries)
  const business = input.employerBusiness === null ? null : foldForKeywords(input.employerBusiness)
  if (business !== null && terms.some((pattern) => pattern.test(business))) {
    return { result: "violated", quote: input.businessQuote }
  }
  const floor = employerSentenceMatch(input.postingText, terms)
  if (floor !== null) return { result: "violated", quote: floor }
  if (business !== null && business.trim() !== "") return { result: "met", quote: input.businessQuote }
  return { result: "unverified", quote: null }
}

function employerSentenceMatch(text: string, terms: readonly RegExp[]): string | null {
  if (terms.length === 0) return null
  for (const sentence of sentencesOf(text)) {
    if (terms.some((pattern) => pattern.test(foldForKeywords(sentence)))) return sentence
  }
  return null
}
