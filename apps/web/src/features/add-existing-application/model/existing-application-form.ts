import { isCalendarDate } from "@eve/contracts"

import {
  existingApplicationCopy as c,
  type NewExistingApplication,
} from "@/entities/existing-application"

export interface ExistingApplicationFormValues {
  company: string
  roleTitle: string
  applicationUrl: string
  requisitionId: string
  /** `YYYY-MM-DD`, or empty until a date is picked. */
  appliedOn: string
}

export type ExistingApplicationField =
  "company" | "roleTitle" | "applicationUrl" | "appliedOn"
export type ExistingApplicationFormErrors = Partial<
  Record<ExistingApplicationField, string>
>

/** The contract's field order (api-contract.md, `existing_application_*_empty`). */
export const FIELD_ORDER: readonly ExistingApplicationField[] = [
  "company",
  "roleTitle",
  "applicationUrl",
  "appliedOn",
]

export const emptyExistingApplicationForm: ExistingApplicationFormValues = {
  company: "",
  roleTitle: "",
  applicationUrl: "",
  requisitionId: "",
  appliedOn: "",
}

/**
 * F1 step 6a.5: the first empty field wins (C-VAL-EXIST-1), in the contract's
 * order. With every field filled, a URL that isn't an absolute http(s) link or
 * a date that isn't a real date shows C-VAL-EXIST-2 under that field.
 */
export function validateExistingApplication(
  values: ExistingApplicationFormValues
): ExistingApplicationFormErrors {
  const firstEmpty = FIELD_ORDER.find((field) => values[field].trim() === "")
  if (firstEmpty) return { [firstEmpty]: c.empties[firstEmpty] }
  const errors: ExistingApplicationFormErrors = {}
  if (!isHttpUrl(values.applicationUrl.trim()))
    errors.applicationUrl = c.malformed.applicationUrl
  if (!isCalendarDate(values.appliedOn.trim()))
    errors.appliedOn = c.malformed.appliedOn
  return errors
}

export function toNewExistingApplication(
  values: ExistingApplicationFormValues
): NewExistingApplication {
  return {
    company: values.company.trim(),
    roleTitle: values.roleTitle.trim(),
    applicationUrl: values.applicationUrl.trim(),
    requisitionId: values.requisitionId.trim() || null,
    appliedOn: values.appliedOn.trim(),
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}
