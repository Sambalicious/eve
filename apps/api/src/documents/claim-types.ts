import { type ContactHeader } from "./document-model.js"

export type ClaimFailureReason = "unsupported_claim" | "unknown_fact" | "no_fact" | "contact_detail" | "names_target"

/**
 * EPIC-0012 Revision 2, 2.3: the reason code of a hard fail, for count-only monitoring. A hard fail is a
 * failure no meaning-check answer can release (the claim and number checks count too, as the design lists).
 */
export type HardFailCode =
  | "borrowed_name"
  | "gap"
  | "role_noun"
  | "support_inflation"
  | "completion_word"
  | "posting_term"
  | "number"
  | "claim_word"
  | "names_target"
  | "unsourced_quote"

export type DocumentValidation =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false
      reason: ClaimFailureReason
      /** The document line that failed, shown in C-DOC-3 as "Claim: …". */
      claim: string
      /** The words or numbers in it that no cited fact supports. */
      unsupported: string[]
      /** Set when the failure is a hard fail (see `HardFailCode`); never carries line text. */
      hardFail?: HardFailCode
    }>

/** What a cover letter may name without a fact: the employer and role it is addressed to. */
export type LetterTarget = Readonly<{ employer: string; roleTitle: string }>

/**
 * EPIC-0012 Revision 2, R8: each cited fact's own wording. The service passes the `wording` map; callers
 * that only have the validation map ("fact text. heading") fall back to the text before the heading.
 */
export type FactWording = ReadonlyMap<string, string> | null

/**
 * EPIC-0012 rule 2 (design 1a, 1c): what the posting lends the truth guard. `text` is normalised and empty
 * when the posting lends no terms; `gaps` are the posting's ATS keywords the profile does not state;
 * `roleNouns` are the posting title's last meaningful word plus `ROLE_NOUNS`; `names` are the words the raw
 * posting writes with a capital first letter or in all caps and never in lower case, wherever they stand,
 * which no line may borrow in any case (Revision 2, R10); `direction` holds the posting's verified
 * forward-looking quotes as the posting row stores them (rule 4, design 2b). Only the generation prompt
 * drops the quotes that name the target, so a stored quote may still name it: `namesTarget` runs on the
 * full line before any span is stripped, so a letter that quotes one that way is still blocked.
 */
export type PostingGuard = Readonly<{
  text: string
  gaps: readonly string[]
  roleNouns: readonly string[]
  names: readonly string[]
  direction: readonly string[]
}>

/**
 * Where a line sits: the bridge allowance differs by section (design 1b, 1c).
 * EPIC-0014 D5 adds `outreach_ask`: one Ask sentence of an Outreach text, which
 * cites no facts. It is treated like `education` for `judgedKind` (the claim
 * check alone; it never demands a judge verdict on its own), so any number, date,
 * capitalised name, listed skill, title or qualification in it still fails. No
 * documents line uses it, so every existing decision is unchanged (AC 13.1).
 */
export type LineKind = "summary" | "experience_heading" | "experience_bullet" | "skills" | "education" | "letter_paragraph" | "outreach_ask"

/**
 * What every claim check reads besides the line itself, so the checks take one parameter object instead of
 * six positional ones. `target` is the letter's addressee (null for a resume: only a letter may name it),
 * `meaningChecked` the meaning-check verdicts held so far, `posting` the posting side of the guard and
 * `wording` each fact's own text. Build a variant with a spread: `{ ...ctx, target: null }`.
 */
export type ClaimContext = Readonly<{
  facts: ReadonlyMap<string, string>
  target: LetterTarget | null
  contact: ContactHeader | null
  meaningChecked: ReadonlySet<string>
  posting: PostingGuard | null
  wording: FactWording
}>
