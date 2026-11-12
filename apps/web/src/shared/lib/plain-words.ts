/**
 * Owner decision 2 (EPIC-0011): with Advanced off, surfaces that stay on screen do not use the retired automation
 * words. This swaps them for plain ones (COPY PROPOSALS for the Copywriter). Longest phrases first. Keep the
 * original strings when Advanced is on.
 */
const PLAIN: readonly (readonly [RegExp, string])[] = [
  [/Open Blocked Applications?|Open Uncertain Submissions?/g, "See what needs you"],
  [/Held for your review/g, "Needs you"],
  [/an Uncertain Submission/g, "a send Eve is unsure about"],
  [/Uncertain Submissions/g, "sends Eve is unsure about"],
  [/Uncertain Submission/g, "Needs you"],
  [/a Blocked Application/g, "an application that needs you"],
  [/Blocked Applications/g, "applications that need you"],
  [/Blocked Application/g, "Needs you"],
  [/a Confirmed Submission/g, "an application Eve sent"],
  [/Confirmed Submissions/g, "applications Eve sent"],
  [/Confirmed Submission/g, "Applied"],
]

export function plainWords(text: string): string {
  return PLAIN.reduce((out, [pattern, plain]) => out.replace(pattern, plain), text)
}
