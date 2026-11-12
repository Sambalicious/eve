/**
 * EPIC-0012 Revision 1, R6: two printed lines are the same when they differ only in case, spacing or
 * one trailing full stop. The density repair and the claim fallback share this test, so one entry's
 * bullets never print the same text twice.
 */
export function sameLine(a: string, b: string): boolean {
  return canonical(a) === canonical(b)
}

/** Trim, collapse whitespace, drop one trailing full stop, fold case. */
function canonical(text: string): string {
  return text.trim().replace(/\s+/g, " ").replace(/\.$/, "").toLowerCase()
}

/**
 * EPIC-0012 Revision 2, 2.1: the text compared for the mechanical pass. It extends `sameLine` with
 * the two rewrites the design allows without a judge: an em or en dash between words becomes ", ",
 * "&" becomes "and", and in a letter a leading "I " is dropped at the start of every sentence (Revision 3,
 * M2: removing the pronoun changes no claim). Everything else is unchanged text.
 */
export function mechanicalKey(text: string, letter = false): string {
  let out = text.trim().replace(/\s+/g, " ")
  if (letter) out = out.replace(/(^|[.!?]\s+)i\s+/gi, "$1")
  out = out.replace(/\s*[\u2014\u2013]\s*/g, ", ").replace(/\s*&\s*/g, " and ")
  return canonical(out)
}

/**
 * EPIC-0012 Revision 2, R15: a meaning-check verdict belongs to one line text and its cited facts.
 * Two identical lines citing different facts must not share one verdict.
 */
export function meaningKey(text: string, factIds: readonly string[]): string {
  return `${text}\u0000${[...factIds].sort().join("\u0000")}`
}

/**
 * EPIC-0012 Revision 2, R13: a finished list keeps its first copy of each line and drops later ones.
 * The first copy is always kept, so a non-empty list never becomes empty.
 */
export function dedupeLines<T extends { text: string }>(lines: readonly T[]): T[] {
  const kept: T[] = []
  for (const line of lines) if (!kept.some((already) => sameLine(already.text, line.text))) kept.push(line)
  return kept
}
