/** Name and contact lines that head every Tailored Document. Never sent to the model (contract v1.5.0). */
export interface ContactDetails {
  readonly fullName: string
  readonly lines: readonly string[]
}

/** Same limits as the contract's `candidateContactSchema`. */
export const CONTACT_NAME_MAX = 120
export const CONTACT_LINE_MAX = 120
export const CONTACT_LINES_MAX = 6

export function hasContactName(contact: ContactDetails): boolean {
  return contact.fullName.trim() !== ""
}
